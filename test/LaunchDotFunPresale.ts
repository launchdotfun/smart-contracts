import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { Log } from "ethers";
import { ethers, fhevm, network } from "hardhat";

import {
  IERC20,
  IERC20__factory,
  LaunchDotFunPresale,
  LaunchDotFunPresaleFactory,
  LaunchDotFunPresaleFactory__factory,
  LaunchDotFunPresale__factory,
  LaunchDotFunTokenFactory,
  LaunchDotFunTokenFactory__factory,
  LaunchDotFunTokenWrapper,
  LaunchDotFunTokenWrapper__factory,
  LaunchDotFunWETH,
  LaunchDotFunWETH__factory,
} from "../types";

const TIME_INCREASE = 7200;
const PRESALE_DURATION = 3600;
const PRESALE_START_OFFSET = 60;
const OPERATOR_EXPIRY_OFFSET = 1000;

const BID_AMOUNTS = {
  alice: ethers.parseUnits("4", 9), // 4
  bob: ethers.parseUnits("4", 9), // 4
  charlie: ethers.parseUnits("2", 9),
} as const;

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

class TestHelpers {
  static async wrapETH(user: HardhatEthersSigner, amount: bigint, zweth: LaunchDotFunWETH) {
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

  static async ensureBidPeriod(presale: LaunchDotFunPresale) {
    const currentTime = await time.latest();
    const pool = await presale.pool();
    if (currentTime < pool.options.start) {
      await time.increaseTo(Number(pool.options.start) + 1);
    }
  }

  static async approveZWETH(user: HardhatEthersSigner, presaleAddress: string, zweth: LaunchDotFunWETH) {
    await zweth.connect(user).setOperator(presaleAddress, BigInt((await time.latest()) + OPERATOR_EXPIRY_OFFSET));
  }

  static async createEncryptedBid(presaleAddress: string, user: HardhatEthersSigner, amount: bigint) {
    return await fhevm.createEncryptedInput(presaleAddress, user.address).add64(amount).encrypt();
  }

  static async performBid(
    presale: LaunchDotFunPresale,
    user: HardhatEthersSigner,
    amount: bigint,
    presaleAddress: string,
  ) {
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

  static async claimTokens(presale: LaunchDotFunPresale, user: HardhatEthersSigner, ztoken: LaunchDotFunTokenWrapper) {
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

  static async finalizePresale(presale: LaunchDotFunPresale, caller: HardhatEthersSigner, totalBid: bigint) {
    await network.provider.send("evm_increaseTime", [TIME_INCREASE]);

    const pool = await presale.pool();

    const hardCapBig = BigInt(pool.options.hardCap.toString());
    const tokenPerEthBig = BigInt(pool.tokenPerEthWithDecimals.toString());

    const ethRaisedUsed = totalBid <= hardCapBig ? totalBid : hardCapBig;

    const fillNumerator = ethRaisedUsed;
    const fillDenominator = totalBid;

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
    presale: LaunchDotFunPresale,
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

describe("LaunchDotFunPresale (bid-based) integration flow", function () {
  let signers: Signers;
  let zweth: LaunchDotFunWETH;
  let factory: LaunchDotFunPresaleFactory;
  let presale: LaunchDotFunPresale;
  let presaleAddress: string;
  let token: IERC20;
  let ztoken: LaunchDotFunTokenWrapper;
  let now: number;

  let zwethAddress: string;
  let tokenAddress: string;
  let ztokenAddress: string;

  async function setupPresale(config = PRESALE_CONFIG) {
    if (!fhevm.isMock) {
      throw new Error("This hardhat test suite cannot run on Sepolia Testnet");
    }

    zweth = (await (
      await new LaunchDotFunWETH__factory(signers.deployer).deploy()
    ).waitForDeployment()) as LaunchDotFunWETH;
    zwethAddress = await zweth.getAddress();

    const tokenFactory = (await (
      await new LaunchDotFunTokenFactory__factory(signers.deployer).deploy()
    ).waitForDeployment()) as LaunchDotFunTokenFactory;

    factory = (await (
      await new LaunchDotFunPresaleFactory__factory(signers.deployer).deploy(
        zwethAddress,
        await tokenFactory.getAddress(),
      )
    ).waitForDeployment()) as LaunchDotFunPresaleFactory;

    const createTokenTx = await tokenFactory
      .connect(signers.deployer)
      .createToken("TestToken", "TTK", 18, config.tokenPresale, "");
    const createTokenReceipt = await createTokenTx.wait();

    type TokenCreatedEvent = {
      name: string;
      args: { tokenAddress: string };
    };

    const tokenCreatedEvent = createTokenReceipt?.logs
      .map((log: unknown) => {
        try {
          return tokenFactory.interface.parseLog(log as Log) as unknown as TokenCreatedEvent;
        } catch {
          return null;
        }
      })
      .find((e: TokenCreatedEvent | null): e is TokenCreatedEvent => e !== null && e.name === "TokenCreated");

    if (!tokenCreatedEvent || !tokenCreatedEvent.args) {
      throw new Error("Failed to extract token address from TokenCreated event");
    }

    tokenAddress = tokenCreatedEvent.args.tokenAddress as string;
    token = IERC20__factory.connect(tokenAddress, signers.deployer) as IERC20;

    await token.connect(signers.deployer).approve(await factory.getAddress(), config.tokenPresale);

    now = await time.latest();

    const presaleOptions = {
      tokenPresale: config.tokenPresale,
      hardCap: config.hardCap,
      softCap: config.softCap,
      start: BigInt(now - PRESALE_START_OFFSET),
      end: BigInt(now + PRESALE_DURATION),
    };

    const tx = await factory.connect(signers.deployer).createLaunchDotFunPresale(tokenAddress, presaleOptions);

    const receipt = await tx.wait();

    type LaunchDotFunPresaleCreatedEvent = {
      name: string;
      args: { presale: string };
    };

    const event = receipt?.logs
      .map((log: unknown) => {
        try {
          return factory.interface.parseLog(log as Log) as unknown as LaunchDotFunPresaleCreatedEvent;
        } catch {
          return null;
        }
      })
      .find(
        (e: LaunchDotFunPresaleCreatedEvent | null): e is LaunchDotFunPresaleCreatedEvent =>
          e !== null && e.name === "LaunchDotFunPresaleCreated",
      ) as LaunchDotFunPresaleCreatedEvent | null;

    presaleAddress = event?.args?.presale ?? "";
    if (!presaleAddress) {
      throw new Error("Failed to extract presale address from deployment event");
    }

    presale = LaunchDotFunPresale__factory.connect(presaleAddress, signers.deployer) as LaunchDotFunPresale;
    const pool = await presale.pool();

    ztoken = LaunchDotFunTokenWrapper__factory.connect(pool.ztoken, signers.deployer) as LaunchDotFunTokenWrapper;

    ztokenAddress = await ztoken.getAddress();

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

    it("non-owner cannot finalize presale", async function () {
      const totalBid = BID_AMOUNTS.alice + BID_AMOUNTS.bob + BID_AMOUNTS.charlie;

      await network.provider.send("evm_increaseTime", [TIME_INCREASE]);

      const pool = await presale.pool();
      const hardCapBig = BigInt(pool.options.hardCap.toString());
      const tokenPerEthBig = BigInt(pool.tokenPerEthWithDecimals.toString());

      const ethRaisedUsed = totalBid <= hardCapBig ? totalBid : hardCapBig;
      const tokensSold = ethRaisedUsed * tokenPerEthBig;

      await expect(
        presale.connect(signers.alice).finalizePreSale(ethRaisedUsed, tokensSold, ethRaisedUsed, totalBid),
      ).to.be.revertedWithCustomError(presale, "OwnableUnauthorizedAccount");
    });
  });

  describe("Oversubscription: total bid > hard cap → pro-rata refunds", function () {
    const OVERSUB_BIDS = {
      alice: ethers.parseUnits("6", 9),
      bob: ethers.parseUnits("5", 9),
      charlie: ethers.parseUnits("4", 9),
    } as const;

    before(async function () {
      await setupPresale();
    });

    it("wrap ETH into zWETH for all bidders", async function () {
      const { clearBalance: a } = await TestHelpers.wrapETH(signers.alice, OVERSUB_BIDS.alice, zweth);
      const { clearBalance: b } = await TestHelpers.wrapETH(signers.bob, OVERSUB_BIDS.bob, zweth);
      const { clearBalance: c } = await TestHelpers.wrapETH(signers.charlie, OVERSUB_BIDS.charlie, zweth);

      expect(a).to.eq(OVERSUB_BIDS.alice);
      expect(b).to.eq(OVERSUB_BIDS.bob);
      expect(c).to.eq(OVERSUB_BIDS.charlie);
    });

    it("Alice, Bob, Charlie place bids (oversubscribed)", async function () {
      await TestHelpers.ensureBidPeriod(presale);

      await TestHelpers.approveZWETH(signers.alice, presaleAddress, zweth);
      await TestHelpers.approveZWETH(signers.bob, presaleAddress, zweth);
      await TestHelpers.approveZWETH(signers.charlie, presaleAddress, zweth);

      const { clearContribution: ca } = await TestHelpers.performBid(
        presale,
        signers.alice,
        OVERSUB_BIDS.alice,
        presaleAddress,
      );
      const { clearContribution: cb } = await TestHelpers.performBid(
        presale,
        signers.bob,
        OVERSUB_BIDS.bob,
        presaleAddress,
      );
      const { clearContribution: cc } = await TestHelpers.performBid(
        presale,
        signers.charlie,
        OVERSUB_BIDS.charlie,
        presaleAddress,
      );

      expect(ca).to.eq(OVERSUB_BIDS.alice);
      expect(cb).to.eq(OVERSUB_BIDS.bob);
      expect(cc).to.eq(OVERSUB_BIDS.charlie);
    });

    it("cannot placeBid after end time", async function () {
      const pool = await presale.pool();
      const end = Number(pool.options.end);

      await time.increaseTo(end + 1);

      const encrypted = await TestHelpers.createEncryptedBid(presaleAddress, signers.alice, OVERSUB_BIDS.alice);

      await expect(
        presale.connect(signers.alice).placeBid(signers.alice.address, encrypted.handles[0], encrypted.inputProof),
      ).to.be.revertedWith("Not in bid period");
    });

    it("finalize presale caps ethRaisedUsed to hardcap and keeps state success", async function () {
      const totalBid = OVERSUB_BIDS.alice + OVERSUB_BIDS.bob + OVERSUB_BIDS.charlie;

      const { ethRaisedUsed, tokensSold } = await TestHelpers.finalizePresale(presale, signers.deployer, totalBid);

      const pool = await presale.pool();
      const rate = BigInt((await ztoken.rate()).toString());

      const expectedWeiRaised = ethRaisedUsed * 10n ** 9n;
      const expectedTokensSoldUnderlying = tokensSold * rate;

      await TestHelpers.validateFinalization(presale, 4, expectedWeiRaised, expectedTokensSoldUnderlying);

      expect(ethRaisedUsed).to.eq(BigInt(pool.options.hardCap.toString()));
      expect(totalBid).to.be.gt(BigInt(pool.options.hardCap.toString()));
    });

    it("Alice settles bid, receives partial refund and claimable tokens", async function () {
      const preBalance = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await zweth.confidentialBalanceOf(signers.alice.address)).toString(),
        await zweth.getAddress(),
        signers.alice,
      );

      expect(preBalance).to.eq(0n);

      await presale.connect(signers.alice).settleBid(signers.alice.address);

      const postBalance = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        (await zweth.confidentialBalanceOf(signers.alice.address)).toString(),
        await zweth.getAddress(),
        signers.alice,
      );

      expect(postBalance).to.be.gt(0n);
      expect(postBalance).to.be.lt(OVERSUB_BIDS.alice);

      const claimable = await presale.claimableTokens(signers.alice.address);
      const clearClaimable = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        claimable.toString(),
        presaleAddress,
        signers.alice,
      );

      expect(clearClaimable).to.be.gt(0n);

      await presale.connect(signers.alice).claimTokens(signers.alice.address);

      const zBal = await ztoken.confidentialBalanceOf(signers.alice.address);
      const clearZBal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        zBal.toString(),
        await ztoken.getAddress(),
        signers.alice,
      );

      expect(clearZBal).to.be.gt(0n);
    });
  });

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

    it("cannot settleBid before presale is finalized", async function () {
      await expect(presale.connect(signers.alice).settleBid(signers.alice.address)).to.be.revertedWith(
        "Presale not successful",
      );
    });

    it("finalize presale: should go to state 3 (cancelled)", async function () {
      const totalBid = BID_AMOUNTS.alice;

      const { ethRaisedUsed } = await TestHelpers.finalizePresale(presale, signers.deployer, totalBid);

      const pool = await presale.pool();

      await TestHelpers.validateFinalization(presale, 3, ethRaisedUsed * 10n ** 9n, pool.tokensSold);
    });

    it("Alice cannot claim tokens in cancelled pool", async function () {
      await expect(presale.connect(signers.alice).claimTokens(signers.alice.address)).to.be.revertedWith(
        "Invalid state",
      );
    });

    it("Alice can refund and get back full zWETH", async function () {
      await presale.connect(signers.alice).refund();

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
