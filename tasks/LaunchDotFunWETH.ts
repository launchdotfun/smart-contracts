import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

import { formatAmount, getSigner, parseAmount } from "./helpers";

task("task:zweth-deposit", "Deposit ETH to LaunchDotFunWETH")
  .addParam("amount", "Amount of ETH to deposit")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addParam("zweth", "LaunchDotFunWETH contract address")
  .addOptionalParam("to", "Recipient address (defaults to user)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Depositing ETH to LaunchDotFunWETH...");

    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const to = taskArguments.to || user.address;
    const amountWei = parseAmount(taskArguments.amount, 18, hre);

    const zweth = await hre.ethers.getContractAt("LaunchDotFunWETH", taskArguments.zweth);
    const zwethAddress = await zweth.getAddress();
    const rate = BigInt((await zweth.rate()).toString());

    if (amountWei <= rate) {
      throw new Error(
        `Deposit amount must be greater than the on-chain rate (${formatAmount(rate, 18, hre)} ETH).`,
      );
    }

    console.log(`Depositing ${formatAmount(amountWei, 18, hre)} ETH...`);
    console.log("From:", user.address);
    console.log("To:", to);

    const tx = await zweth.connect(user).deposit(to, { value: amountWei });
    await tx.wait();

    let clearBalanceAfter: bigint | null = null;
    const balanceAfter = await zweth.confidentialBalanceOf(to);
    if (to.toLowerCase() === user.address.toLowerCase()) {
      clearBalanceAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        balanceAfter.toString(),
        zwethAddress,
        user,
      );
    } else {
      console.log("Recipient differs from sender. Skipping decrypted balance output.");
    }

    const minted = amountWei / rate;

    console.log("✅ Deposit completed successfully!");
    console.log("Deposited amount (ETH):", formatAmount(amountWei, 18, hre));
    console.log("Minted zWETH:", formatAmount(minted, 9, hre));
    if (clearBalanceAfter !== null) {
      console.log("Balance after:", formatAmount(clearBalanceAfter, 9, hre));
    }

    return {
      from: user.address,
      to: to,
      depositedAmount: amountWei,
      newBalance: clearBalanceAfter,
    };
  });

task("task:zweth-withdraw", "Withdraw ETH from LaunchDotFunWETH")
  .addParam("amount", "Amount of zWETH to withdraw")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addParam("zweth", "LaunchDotFunWETH contract address")
  .addOptionalParam("to", "Recipient address for ETH")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Withdrawing ETH from LaunchDotFunWETH...");

    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const amountZweth = parseAmount(taskArguments.amount, 9, hre);
    if (amountZweth <= 0n) {
      throw new Error("Amount must be greater than zero");
    }

    const zweth = await hre.ethers.getContractAt("LaunchDotFunWETH", taskArguments.zweth);
    const zwethAddress = await zweth.getAddress();
    const rate = BigInt((await zweth.rate()).toString());
    const to = taskArguments.to || user.address;

    console.log(`Withdrawing ${formatAmount(amountZweth, 9, hre)} zWETH...`);
    console.log("From:", user.address);
    console.log("To:", to);

    const balance = await zweth.confidentialBalanceOf(user.address);
    const clearBalance = await fhevm.userDecryptEuint(FhevmType.euint64, balance.toString(), zwethAddress, user);

    if (clearBalance < amountZweth) {
      throw new Error(
        `Insufficient zWETH balance. Have: ${formatAmount(clearBalance, 9, hre)}, Need: ${formatAmount(amountZweth, 9, hre)}`,
      );
    }

    const ethBalanceBefore = await hre.ethers.provider.getBalance(to);

    console.log("Creating encrypted withdrawal input...");
    const encrypted = await fhevm.createEncryptedInput(zwethAddress, user.address).add64(amountZweth).encrypt();

    if (amountZweth > (1n << 64n) - 1n) {
      throw new Error("Amount exceeds uint64 range required by withdraw");
    }
    const amountUint64 = Number(amountZweth);

    console.log("Executing withdrawal...");
    const tx = await zweth
      .connect(user)
      [
        "withdrawAndFinalize(address,address,bytes32,bytes,uint64)"
      ](user.address, to, encrypted.handles[0], encrypted.inputProof, amountUint64);
    await tx.wait();

    const ethBalanceAfter = await hre.ethers.provider.getBalance(to);
    const ethReceived = ethBalanceAfter - ethBalanceBefore;

    console.log("✅ Withdrawal completed successfully!");
    console.log("zWETH burned:", formatAmount(amountZweth, 9, hre));
    console.log("ETH received:", formatAmount(ethReceived, 18, hre));
    console.log("Expected ETH (zWETH * rate):", formatAmount(amountZweth * rate, 18, hre));

    return {
      from: user.address,
      to: to,
      withdrawnAmount: ethReceived,
    };
  });

task("task:zweth-balance", "Get LaunchDotFunWETH balance")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addParam("zweth", "LaunchDotFunWETH contract address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Getting LaunchDotFunWETH balance...");

    await fhevm.initializeCLIApi();

    console.log("Initializing FHEVM successfully");

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const zweth = await hre.ethers.getContractAt("LaunchDotFunWETH", taskArguments.zweth);
    const zwethAddress = await zweth.getAddress();

    console.log("Getting LaunchDotFunWETH balance of user...");
    const balance = await zweth.confidentialBalanceOf(user.address);
    const clearBalance = await fhevm.userDecryptEuint(FhevmType.euint64, balance.toString(), zwethAddress, user);
    console.log("Cleared balance:", formatAmount(clearBalance, 9, hre));

    console.log("👤 LaunchDotFunWETH Balance:");
    console.log("User address:", user.address);
    console.log("Balance:", formatAmount(clearBalance, 9, hre));

    return {
      address: user.address,
      balance: clearBalance,
    };
  });

task("task:zweth-info", "Get LaunchDotFunWETH contract information")
  .addParam("zweth", "LaunchDotFunWETH contract address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    console.log("Getting LaunchDotFunWETH contract information...");

    const zweth = await hre.ethers.getContractAt("LaunchDotFunWETH", taskArguments.zweth);

    const [name, symbol, decimals, rateRaw] = await Promise.all([
      zweth.name(),
      zweth.symbol(),
      zweth.decimals(),
      zweth.rate(),
    ]);
    const rate = BigInt(rateRaw.toString());

    console.log("📊 LaunchDotFunWETH Contract Information:");
    console.log("Address:", taskArguments.zweth);
    console.log("Name:", name);
    console.log("Symbol:", symbol);
    console.log("Decimals:", decimals);
    console.log("Rate:", rate.toString());
    console.log("Rate explanation: 1 zWETH =", formatAmount(rate, 18, hre), "ETH");

    return {
      address: taskArguments.zweth,
      name,
      symbol,
      decimals,
      rate,
    };
  });
