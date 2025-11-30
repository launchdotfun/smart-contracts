import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

async function getSigner(hre: HardhatRuntimeEnvironment, userIndex: number) {
  const signers = await hre.ethers.getSigners();
  if (userIndex >= signers.length) {
    throw new Error(`User index ${userIndex} out of range. Available: 0-${signers.length - 1}`);
  }
  return signers[userIndex];
}

function formatAmount(amount: bigint, decimals: number = 9, hre: HardhatRuntimeEnvironment): string {
  return hre.ethers.formatUnits(amount, decimals);
}

function parseAmount(amount: string, decimals: number = 9, hre: HardhatRuntimeEnvironment): bigint {
  return hre.ethers.parseUnits(amount, decimals);
}

task("task:create-presale", "Create a new privacy presale")
  .addParam("name", "Token name")
  .addParam("symbol", "Token symbol")
  .addParam("hardcap", "Hard cap in ETH")
  .addParam("softcap", "Soft cap in ETH")
  .addParam("tokenpresale", "Token presale amount")
  .addParam("tokenaddliquidity", "Token add liquidity amount")
  .addParam("maxcontribution", "Max contribution in ETH")
  .addParam("mincontribution", "Min contribution in ETH")
  .addOptionalParam("factory", "Factory contract address")
  .addOptionalParam("duration", "Presale duration in hours", "1")
  .addOptionalParam("liquidity", "Liquidity percentage (0-100)", "50")
  .addOptionalParam("user", "User index (0, 1, 2, etc.)", "0")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Creating new privacy presale...");

    await fhevm.initializeCLIApi();

    const signers = await hre.ethers.getSigners();
    const deployer = signers[parseInt(taskArguments.user)];
    console.log("Deployer address:", deployer.address);

    let factoryAddress = taskArguments.factory;
    if (!factoryAddress) {
      try {
        const { deployments } = hre;
        const factoryDeployment = await deployments.get("LaunchDotFunPresaleFactory");
        factoryAddress = factoryDeployment.address;
      } catch {
        throw new Error(
          "Factory address not provided and not found in deployments. Please deploy factory first or provide --factory address",
        );
      }
    }
    console.log("Factory address:", factoryAddress);

    const factory = await hre.ethers.getContractAt("LaunchDotFunPresaleFactory", factoryAddress);

    const hardCap = parseAmount(taskArguments.hardcap, 9, hre);
    const softCap = parseAmount(taskArguments.softcap, 9, hre);
    const duration = parseInt(taskArguments.duration) * 3600; // Convert hours to seconds
    const liquidityPercentage = BigInt(parseInt(taskArguments.liquidity) * 100); // Convert to basis points
    const maxContribution = parseAmount(taskArguments.maxcontribution, 9, hre);
    const minContribution = parseAmount(taskArguments.mincontribution, 9, hre);

    const now = Math.floor(Date.now() / 1000);
    const startTime = BigInt(now);
    const endTime = BigInt(now + duration + 180);

    const tokenPresale = hre.ethers.parseUnits(taskArguments.tokenpresale, 18);
    const tokenAddLiquidity = hre.ethers.parseUnits(taskArguments.tokenaddliquidity, 18);

    const presaleOptions = {
      tokenAddLiquidity,
      tokenPresale,
      liquidityPercentage,
      hardCap: BigInt(hardCap),
      softCap: BigInt(softCap),
      start: startTime,
      end: endTime,
      maxContribution: BigInt(maxContribution),
      minContribution: BigInt(minContribution),
    };

    console.log("Presale configuration:");
    console.log("- Token name:", taskArguments.name);
    console.log("- Token symbol:", taskArguments.symbol);
    console.log("- Hard cap:", formatAmount(hardCap, 9, hre), "ETH");
    console.log("- Soft cap:", formatAmount(softCap, 9, hre), "ETH");
    console.log("- Duration:", taskArguments.duration, "hours");
    console.log("- Liquidity percentage:", taskArguments.liquidity, "%");
    console.log("- Start time:", new Date(Number(startTime) * 1000).toISOString());
    console.log("- End time:", new Date(Number(endTime) * 1000).toISOString());

    const tx = await factory
      .connect(deployer)
      .createLaunchDotFunPresaleWithNewToken(
        taskArguments.name,
        taskArguments.symbol,
        tokenPresale + tokenAddLiquidity,
        presaleOptions,
      );

    console.log("Creating presale...");
    const receipt = await tx.wait();

    const event = receipt?.logs
      .map((log: unknown) => {
        try {
          return factory.interface.parseLog(log as { topics: readonly string[]; data: string });
        } catch {
          return null;
        }
      })
      .find((e: unknown) => e && (e as { name?: string }).name === "LaunchDotFunPresaleCreated");

    if (!event) {
      throw new Error("Failed to extract presale address from deployment event");
    }

    const presaleAddress = event.args.presale;
    const tokenAddress = event.args.token;
    const ctokenAddress = event.args.ztoken;

    console.log("✅ Presale created successfully!");
    console.log("Presale address:", presaleAddress);
    console.log("Token address:", tokenAddress);
    console.log("Confidential token address:", ctokenAddress);

    return { presaleAddress, tokenAddress, ctokenAddress };
  });

task("task:purchase", "Purchase tokens in a presale")
  .addParam("amount", "Amount of zWETH to invest")
  .addParam("presale", "Presale contract address")
  .addOptionalParam("beneficiary", "Beneficiary address (defaults to user)")
  .addOptionalParam("user", "User index (0, 1, 2, etc.)", "0")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Purchasing tokens in presale...");

    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const beneficiary = taskArguments.beneficiary || user.address;
    const amount = parseAmount(taskArguments.amount, 9, hre);

    const presale = await hre.ethers.getContractAt("LaunchDotFunPresale", taskArguments.presale);

    const pool = await presale.pool();
    const zwethAddress = pool.zweth;
    const zweth = await hre.ethers.getContractAt("LaunchDotFunWETH", zwethAddress);

    console.log(`Purchasing ${formatAmount(amount, 9, hre)} zWETH worth of tokens...`);
    console.log("User:", user.address);
    console.log("Beneficiary:", beneficiary);

    const balance = await zweth.confidentialBalanceOf(user.address);
    const clearBalance = await fhevm.userDecryptEuint(FhevmType.euint64, balance.toString(), zwethAddress, user);

    if (clearBalance < amount) {
      throw new Error(`Insufficient zWETH balance. Have: ${clearBalance}, Need: ${amount}`);
    }

    console.log("Approving presale to spend zWETH...");
    const now = Math.floor(Date.now() / 1000);
    const expiry = BigInt(now + 1000);
    await zweth.connect(user).setOperator(taskArguments.presale, expiry);

    console.log("Creating encrypted purchase input...");
    const encrypted = await fhevm.createEncryptedInput(taskArguments.presale, user.address).add64(amount).encrypt();

    console.log("Executing purchase...");
    const tx = await presale.connect(user).placeBid(beneficiary, encrypted.handles[0], encrypted.inputProof);
    await tx.wait();

    const [contribution, claimableTokens] = await Promise.all([
      presale.contributions(beneficiary),
      presale.claimableTokens(beneficiary),
    ]);

    const [clearContribution, clearClaimableTokens] = await Promise.all([
      fhevm.userDecryptEuint(FhevmType.euint64, contribution.toString(), taskArguments.presale, user),
      fhevm.userDecryptEuint(FhevmType.euint64, claimableTokens.toString(), taskArguments.presale, user),
    ]);

    console.log("✅ Purchase completed successfully!");
    console.log("Contribution:", clearContribution.toString());
    console.log("Claimable tokens:", clearClaimableTokens.toString());

    return { contribution: clearContribution, claimableTokens: clearClaimableTokens };
  });

task("task:finalize-presale", "Finalize a presale")
  .addParam("presale", "Presale contract address")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Finalizing presale...");

    await fhevm.initializeCLIApi();

    const _user = await getSigner(hre, parseInt(taskArguments.user));
    const presale = await hre.ethers.getContractAt("LaunchDotFunPresale", taskArguments.presale);

    const pool = await presale.pool();
    const ethRaised = await fhevm.publicDecryptEuint(FhevmType.euint64, pool.ethRaisedEncrypted.toString());
    const tokensSold = pool.tokensSold;

    console.log("Pool state:", pool.state);
    console.log("Eth raised:", formatAmount(ethRaised, 9, hre), "ETH");
    console.log("Tokens sold:", formatAmount(tokensSold, 9, hre), "TTK");

    const fillNumerator = 1n;
    const fillDenominator = 1n;

    const tx = await presale.connect(_user).finalizePreSale(ethRaised, tokensSold, fillNumerator, fillDenominator);
    await tx.wait();

    console.log("✅ Finalization completed successfully!");
    console.log("Transaction hash:", tx.hash);

    return {
      state: pool.state,
      tokensSold,
      ethRaised,
    };
  });

task("task:claim-tokens", "Claim tokens after successful presale")
  .addParam("presale", "Presale contract address")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addOptionalParam("beneficiary", "Beneficiary address (defaults to user)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Claiming tokens...");

    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const beneficiary = taskArguments.beneficiary || user.address;

    const presale = await hre.ethers.getContractAt("LaunchDotFunPresale", taskArguments.presale);

    const pool = await presale.pool();
    if (Number(pool.state) !== 4) {
      throw new Error(`Presale is not finalized. Current state: ${pool.state}`);
    }

    const claimed = await presale.claimed(user.address);
    if (claimed) {
      throw new Error("Tokens already claimed by this user");
    }

    const claimableTokens = await presale.claimableTokens(user.address);
    const clearClaimableTokens = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      claimableTokens.toString(),
      taskArguments.presale,
      user,
    );

    console.log(`Claiming ${formatAmount(clearClaimableTokens, 9, hre)} tokens for ${beneficiary}...`);

    const tx = await presale.connect(user).claimTokens(beneficiary);
    await tx.wait();

    const ztoken = await hre.ethers.getContractAt("LaunchDotFunTokenWrapper", pool.ztoken);
    const balance = await ztoken.confidentialBalanceOf(beneficiary);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      await ztoken.getAddress(),
      user,
    );

    console.log("✅ Tokens claimed successfully!");
    console.log("Claimed amount:", clearClaimableTokens.toString());
    console.log("New balance:", clearBalance.toString());

    return { claimedAmount: clearClaimableTokens, newBalance: clearBalance };
  });

task("task:refund", "Refund contribution for failed presale")
  .addParam("presale", "Presale contract address")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addOptionalParam("beneficiary", "Beneficiary address (defaults to user)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Processing refund...");

    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));

    const presale = await hre.ethers.getContractAt("LaunchDotFunPresale", taskArguments.presale);

    const pool = await presale.pool();
    if (Number(pool.state) !== 3) {
      throw new Error(`Presale is not cancelled. Current state: ${pool.state}`);
    }

    const refunded = await presale.refunded(user.address);
    if (refunded) {
      throw new Error("Contribution already refunded for this user");
    }

    const contribution = await presale.contributions(user.address);
    const clearContribution = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      contribution.toString(),
      taskArguments.presale,
      user,
    );

    console.log(`Refunding ${clearContribution.toString()} ETH to ${user.address}...`);

    const tx = await presale.connect(user).refund();
    await tx.wait();

    console.log("✅ Refund processed successfully!");
    console.log("Refunded amount:", clearContribution.toString());

    return { refundedAmount: clearContribution };
  });

task("task:presale-info", "Get presale information")
  .addParam("presale", "Presale contract address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Getting presale information...");

    await fhevm.initializeCLIApi();

    const presale = await hre.ethers.getContractAt("LaunchDotFunPresale", taskArguments.presale);
    const pool = await presale.pool();

    let stateDescription = "Unknown";
    switch (Number(pool.state)) {
      case 1:
        stateDescription = "Active";
        break;
      case 2:
        stateDescription = "Waiting for finalize";
        break;
      case 3:
        stateDescription = "Cancelled";
        break;
      case 4:
        stateDescription = "Finalized";
        break;
    }

    console.log("📊 Presale Information:");
    console.log("Address:", taskArguments.presale);
    console.log("State:", pool.state, `(${stateDescription})`);
    console.log("Token address:", pool.token);
    console.log("Confidential token address:", pool.ztoken);
    console.log("zWETH address:", pool.zweth);
    console.log("Wei raised:", formatAmount(pool.weiRaised, 9, hre));
    console.log("Tokens sold:", formatAmount(pool.tokensSold, 18, hre));
    console.log("Token balance:", formatAmount(pool.tokenBalance, 18, hre));
    console.log("Token per ETH:", pool.tokenPerEthWithDecimals.toString());
    console.log("");
    console.log("📋 Presale Options:");
    console.log("Hard cap:", formatAmount(pool.options.hardCap, 9, hre));
    console.log("Soft cap:", formatAmount(pool.options.softCap, 9, hre));
    console.log("Token presale:", formatAmount(pool.options.tokenPresale, 18, hre));
    console.log("Start time:", new Date(Number(pool.options.start) * 1000).toISOString());
    console.log("End time:", new Date(Number(pool.options.end) * 1000).toISOString());

    return {
      address: taskArguments.presale,
      state: pool.state,
      stateDescription,
      weiRaised: pool.weiRaised,
      tokensSold: pool.tokensSold,
      options: pool.options,
    };
  });

task("task:user-info", "Get user contribution and claim information")
  .addParam("presale", "Presale contract address")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Getting user information...");

    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const presale = await hre.ethers.getContractAt("LaunchDotFunPresale", taskArguments.presale);

    const [contribution, claimableTokens, claimed, refunded] = await Promise.all([
      presale.contributions(user.address),
      presale.claimableTokens(user.address),
      presale.claimed(user.address),
      presale.refunded(user.address),
    ]);

    const [clearContribution, clearClaimableTokens] = await Promise.all([
      fhevm.userDecryptEuint(FhevmType.euint64, contribution.toString(), taskArguments.presale, user),
      fhevm.userDecryptEuint(FhevmType.euint64, claimableTokens.toString(), taskArguments.presale, user),
    ]);

    console.log("👤 User Information:");
    console.log("Address:", user.address);
    console.log("Contribution:", clearContribution.toString());
    console.log("Claimable tokens:", clearClaimableTokens.toString());
    console.log("Has claimed:", claimed);
    console.log("Has refunded:", refunded);

    return {
      address: user.address,
      contribution: clearContribution,
      claimableTokens: clearClaimableTokens,
      claimed,
      refunded,
    };
  });
