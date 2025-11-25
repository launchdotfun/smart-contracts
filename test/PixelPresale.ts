import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Log } from "ethers";
import { ethers, fhevm, network } from "hardhat";

import {
  IERC20,
  IERC20__factory,
  PixelPresale,
  PixelPresaleFactory,
  PixelPresaleFactory__factory,
  PixelPresale__factory,
  PixelTokenFactory,
  PixelTokenFactory__factory,
  PixelTokenWrapper,
  PixelTokenWrapper__factory,
  PixelWETH,
  PixelWETH__factory,
} from "../types";

// ====== Constants ======

const TIME_INCREASE = 7200; // 2 hours
const PRESALE_DURATION = 3600; // 1 hour
const PRESALE_START_OFFSET = 60; // 1 minute ago
const OPERATOR_EXPIRY_OFFSET = 1000; // 1000 seconds from now

// Bid amounts (in zWETH units, 9 decimals)
const BID_AMOUNTS = {
  alice: ethers.parseUnits("4", 9), // 4
  bob: ethers.parseUnits("4", 9), // 4
  charlie: ethers.parseUnits("2", 9), // 2
} as const;

// Presale base config
const PRESALE_CONFIG = {
  hardCap: ethers.parseUnits("10", 9), // 10
  softCap: ethers.parseUnits("6", 9), // 6
  tokenPresale: ethers.parseUnits("1000000000", 18), // 1_000_000_000
} as const;

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  charlie: HardhatEthersSigner;
};

// ====== Test helpers ======

class TestHelpers {
  static async wrapETH(user: HardhatEthersSigner, amount: bigint, zweth: PixelWETH) {
    if (amount > 0n) {
      const wrapAmount = amount * 10n ** 9n; // zWETH has 9 decimals
      await zweth.connect(user).deposit(user.address, { value: wrapAmount });
    }

    const balance = await zweth.confidentialBalanceOf(user.address);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      await zweth.getAddress(),
      user,
    );
    return { balance, clearBalance };
  }

  static async ensureBidPeriod(presale: PixelPresale) {
    const currentTime = await time.latest();
    const pool = await presale.pool();
    if (currentTime < pool.options.start) {
      await time.increaseTo(Number(pool.options.start) + 1);
    }
  }

  static async approveZWETH(user: HardhatEthersSigner, presaleAddress: string, zweth: PixelWETH) {
    await zweth.connect(user).setOperator(presaleAddress, BigInt((await time.latest()) + OPERATOR_EXPIRY_OFFSET));
  }

  static async createEncryptedBid(presaleAddress: string, user: HardhatEthersSigner, amount: bigint) {
    // Hardhat fhevm plugin: createEncryptedInput(contract, user).add64(amount)
    return await fhevm.createEncryptedInput(presaleAddress, user.address).add64(amount).encrypt();
  }

  static async performBid(presale: PixelPresale, user: HardhatEthersSigner, amount: bigint, presaleAddress: string) {
    const encrypted = await this.createEncryptedBid(presaleAddress, user, amount);

    await presale.connect(user).placeBid(user.address, encrypted.handles[0], encrypted.inputProof);

    const contribution = await presale.contributions(user.address);
    const clearContribution = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      contribution.toString(),
      presaleAddress,
      user,
    );

    return { clearContribution };
  }

  static async claimTokens(presale: PixelPresale, user: HardhatEthersSigner, ztoken: PixelTokenWrapper) {
    await presale.connect(user).claimTokens(user.address);

    const balance = await ztoken.confidentialBalanceOf(user.address);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      await ztoken.getAddress(),
      user,
    );
    return clearBalance;
  }

  static async finalizePresale(
    presale: PixelPresale,
    caller: HardhatEthersSigner,
    totalBid: bigint, // truyền từ test vào
  ) {
    await network.provider.send("evm_increaseTime", [TIME_INCREASE]);

    const pool = await presale.pool();

    const hardCapBig = BigInt(pool.options.hardCap.toString());
    const tokenPerEthBig = BigInt(pool.tokenPerEthWithDecimals.toString());

    // ethRaisedUsed: số zWETH thực sự được dùng
    const ethRaisedUsed = totalBid <= hardCapBig ? totalBid : hardCapBig;

    // fill ratio pro-rata
    const fillNumerator = ethRaisedUsed;
    const fillDenominator = totalBid;

    // tokensSold (zToken units)
    const tokensSold = ethRaisedUsed * tokenPerEthBig;

    await presale.connect(caller).finalizePreSale(ethRaisedUsed, tokensSold, fillNumerator, fillDenominator);

    return {
      totalBid,
      ethRaisedUsed,
      fillNumerator,
      fillDenominator,
      tokensSold,
      tokenPerEthBig,
    };
  }

  static async validateFinalization(
    presale: PixelPresale,
    expectedState: number,
    expectedWeiRaised: bigint,
    expectedTokensSoldUnderlying: bigint,
  ) {
    const pool = await presale.pool();
    expect(pool.state).to.eq(expectedState);
    expect(pool.weiRaised).to.eq(expectedWeiRaised);
    expect(pool.tokensSold).to.eq(expectedTokensSoldUnderlying);
    return pool;
  }
}

// ====== Test suite ======

describe("PixelPresale (bid-based) integration flow", function () {
  let signers: Signers;
  let zweth: PixelWETH;
  let factory: PixelPresaleFactory;
  let presale: PixelPresale;
  let presaleAddress: string;
  let token: IERC20;
  let ztoken: PixelTokenWrapper;
  let now: number;

  let zwethAddress: string;
  let tokenAddress: string;
  let ztokenAddress: string;

  async function setupPresale(config = PRESALE_CONFIG) {
    if (!fhevm.isMock) {
      throw new Error("This hardhat test suite cannot run on Sepolia Testnet");
    }

    // Deploy zWETH
    zweth = (await (await new PixelWETH__factory(signers.deployer).deploy()).waitForDeployment()) as PixelWETH;
    zwethAddress = await zweth.getAddress();

    // Deploy PixelTokenFactory
    const tokenFactory = (await (
      await new PixelTokenFactory__factory(signers.deployer).deploy()
    ).waitForDeployment()) as PixelTokenFactory;

    // Deploy PixelPresaleFactory
    factory = (await (
      await new PixelPresaleFactory__factory(signers.deployer).deploy(zwethAddress, await tokenFactory.getAddress())
    ).waitForDeployment()) as PixelPresaleFactory;

    now = await time.latest();

    const presaleOptions = {
      tokenPresale: config.tokenPresale,
      hardCap: config.hardCap,
      softCap: config.softCap,
      start: BigInt(now - PRESALE_START_OFFSET),
      end: BigInt(now + PRESALE_DURATION),
    };

    const tx = await factory.createPixelPresaleWithNewToken(
      "TestToken",
      "TTK",
      config.tokenPresale, // totalSupply = tokenPresale (đơn giản)
      presaleOptions,
    );

    const receipt = await tx.wait();

    type PixelPresaleCreatedEvent = {
      name: string;
      args: { presale: string };
    };

    const event = receipt?.logs
      .map((log: unknown) => {
        try {
          return factory.interface.parseLog(log as Log) as unknown as PixelPresaleCreatedEvent;
        } catch {
          return null;
        }
      })
      .find(
        (e: PixelPresaleCreatedEvent | null): e is PixelPresaleCreatedEvent =>
          e !== null && e.name === "PixelPresaleCreated",
      ) as PixelPresaleCreatedEvent | null;

    presaleAddress = event?.args?.presale ?? "";
    if (!presaleAddress) {
      throw new Error("Failed to extract presale address from deployment event");
    }

    presale = PixelPresale__factory.connect(presaleAddress, signers.deployer) as PixelPresale;
    const pool = await presale.pool();

    ztoken = PixelTokenWrapper__factory.connect(pool.ztoken, signers.deployer) as PixelTokenWrapper;
    token = IERC20__factory.connect(pool.token, signers.deployer) as IERC20;

    ztokenAddress = await ztoken.getAddress();
    tokenAddress = await token.getAddress();

    console.table({
      token: tokenAddress,
      zweth: zwethAddress,
      presale: presaleAddress,
      ztoken: ztokenAddress,
    });
  }

  before(async function () {
    const ethSigners: HardhatEthersSigner[] = await ethers.getSigners();
    signers = {
      deployer: ethSigners[0],
      alice: ethSigners[1],
      bob: ethSigners[2],
      charlie: ethSigners[3],
    };

    console.table({
      deployer: signers.deployer.address,
      alice: signers.alice.address,
      bob: signers.bob.address,
      charlie: signers.charlie.address,
    });
  });

  // ===== Happy case: oversubscription / full hard cap, success, pro-rata allocation =====

  describe("Happy path: bids reach/exceed hard cap → presale success", function () {
    before(async function () {
      await setupPresale();
    });

    it("wrap ETH into zWETH for all bidders", async function () {
      const { clearBalance: a } = await TestHelpers.wrapETH(signers.alice, BID_AMOUNTS.alice, zweth);
      const { clearBalance: b } = await TestHelpers.wrapETH(signers.bob, BID_AMOUNTS.bob, zweth);
      const { clearBalance: c } = await TestHelpers.wrapETH(signers.charlie, BID_AMOUNTS.charlie, zweth);

      expect(a).to.eq(BID_AMOUNTS.alice);
      expect(b).to.eq(BID_AMOUNTS.bob);
      expect(c).to.eq(BID_AMOUNTS.charlie);
    });

    it("Alice, Bob, Charlie place bids", async function () {
      await TestHelpers.ensureBidPeriod(presale);

      await TestHelpers.approveZWETH(signers.alice, presaleAddress, zweth);
      await TestHelpers.approveZWETH(signers.bob, presaleAddress, zweth);
      await TestHelpers.approveZWETH(signers.charlie, presaleAddress, zweth);

      const { clearContribution: ca } = await TestHelpers.performBid(
        presale,
        signers.alice,
        BID_AMOUNTS.alice,
        presaleAddress,
      );
      const { clearContribution: cb } = await TestHelpers.performBid(
        presale,
        signers.bob,
        BID_AMOUNTS.bob,
        presaleAddress,
      );
      const { clearContribution: cc } = await TestHelpers.performBid(
        presale,
        signers.charlie,
        BID_AMOUNTS.charlie,
        presaleAddress,
      );

      expect(ca).to.eq(BID_AMOUNTS.alice);
      expect(cb).to.eq(BID_AMOUNTS.bob);
      expect(cc).to.eq(BID_AMOUNTS.charlie);
    });

    it("finalize presale using decrypted totals and fill ratio", async function () {
      // Sum of all bids: Alice (4) + Bob (4) + Charlie (2) = 10
      const totalBid = BID_AMOUNTS.alice + BID_AMOUNTS.bob + BID_AMOUNTS.charlie;

      const { ethRaisedUsed, tokensSold, tokenPerEthBig } = await TestHelpers.finalizePresale(
        presale,
        signers.deployer,
        totalBid,
      );

      const pool = await presale.pool();
      const rate = BigInt((await ztoken.rate()).toString());

      const expectedWeiRaised = ethRaisedUsed * 10n ** 9n;
      const expectedTokensSoldUnderlying = tokensSold * rate;

      // With totalBid = 10, ethRaisedUsed = 10, softCap = 6 ⇒ state 4 (success)
      const expectedState = ethRaisedUsed >= BigInt(pool.options.softCap.toString()) ? 4 : 3;

      await TestHelpers.validateFinalization(presale, expectedState, expectedWeiRaised, expectedTokensSoldUnderlying);

      console.log("totalBid    :", totalBid.toString());
      console.log("ethUsed     :", ethRaisedUsed.toString());
      console.log("tokenPerEth :", tokenPerEthBig.toString());
    });

    it("Alice can settle bid and claim tokens", async function () {
      await presale.connect(signers.alice).settleBid(signers.alice.address);
      const clearBalance = await TestHelpers.claimTokens(presale, signers.alice, ztoken);
      expect(clearBalance).to.be.gt(0n);
    });

    it("Bob can settle bid and claim tokens", async function () {
      await presale.connect(signers.bob).settleBid(signers.bob.address);
      const clearBalance = await TestHelpers.claimTokens(presale, signers.bob, ztoken);
      expect(clearBalance).to.be.gt(0n);
    });

    it("Charlie can settle bid and claim tokens", async function () {
      await presale.connect(signers.charlie).settleBid(signers.charlie.address);
      const clearBalance = await TestHelpers.claimTokens(presale, signers.charlie, ztoken);
      expect(clearBalance).to.be.gt(0n);
    });

    it("Alice cannot claim twice", async function () {
      await expect(presale.connect(signers.alice).claimTokens(signers.alice.address)).to.be.revertedWith(
        "Already claimed",
      );
    });
  });

  // ===== Sad case: only Alice bids below softCap → presale fails, full refund =====

  describe("Sad path: only Alice bids below softCap → presale cancelled", function () {
    before(async function () {
      await setupPresale();
    });

    it("wrap ETH for Alice", async function () {
      const { clearBalance } = await TestHelpers.wrapETH(signers.alice, BID_AMOUNTS.alice, zweth);
      expect(clearBalance).to.eq(BID_AMOUNTS.alice);
    });

    it("Alice places bid", async function () {
      await TestHelpers.ensureBidPeriod(presale);
      await TestHelpers.approveZWETH(signers.alice, presaleAddress, zweth);

      const { clearContribution } = await TestHelpers.performBid(
        presale,
        signers.alice,
        BID_AMOUNTS.alice,
        presaleAddress,
      );

      expect(clearContribution).to.eq(BID_AMOUNTS.alice);
    });

    it("finalize presale: should go to state 3 (cancelled)", async function () {
      const totalBid = BID_AMOUNTS.alice;

      const { ethRaisedUsed } = await TestHelpers.finalizePresale(presale, signers.deployer, totalBid);

      const pool = await presale.pool();

      // do Alice bid < softCap → state phải là 3 (thất bại)
      await TestHelpers.validateFinalization(
        presale,
        3,
        ethRaisedUsed * 10n ** 9n,
        pool.tokensSold, // ở đây chỉ check state + weiRaised là chính
      );
    });

    it("Alice cannot claim tokens in cancelled pool", async function () {
      await expect(presale.connect(signers.alice).claimTokens(signers.alice.address)).to.be.revertedWith(
        "Invalid state",
      );
    });

    it("Alice can refund and get back full zWETH", async function () {
      await presale.connect(signers.alice).refund();

      // Kiểm tra lại balance zWETH sau refund
      const balance = await zweth.confidentialBalanceOf(signers.alice.address);
      const clear = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        balance.toString(),
        await zweth.getAddress(),
        signers.alice,
      );

      expect(clear).to.eq(BID_AMOUNTS.alice);
    });

    it("Alice cannot refund twice", async function () {
      await expect(presale.connect(signers.alice).refund()).to.be.revertedWith("Already refunded");
    });
  });
});
