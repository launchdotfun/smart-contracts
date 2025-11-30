import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import { formatAmount, getSigner, parseAmount } from "./helpers";

const ERC20_METADATA_ABI = ["function decimals() view returns (uint8)"];

async function readTokenDecimals(
  hre: HardhatRuntimeEnvironment,
  tokenAddress: string,
  fallback: number,
): Promise<number> {
  try {
    const contract = new hre.ethers.Contract(tokenAddress, ERC20_METADATA_ABI, hre.ethers.provider);
    const value = await contract.decimals();
    return typeof value === "number" ? value : Number(value);
  } catch {
    return fallback;
  }
}

/**
 * Wrap underlying ERC20 tokens into confidential tokens
 * Example: npx hardhat --network sepolia task:ztoken-wrap --amount 100 --user 1 --ztoken 0x... --to 0x...
 */
task("task:ztoken-wrap", "Wrap underlying ERC20 tokens into confidential tokens")
  .addParam("amount", "Amount of underlying tokens to wrap")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addParam("ztoken", "LaunchDotFunTokenWrapper contract address")
  .addOptionalParam("to", "Recipient address for confidential tokens (defaults to user)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Wrapping underlying tokens into confidential tokens...");

    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const to = taskArguments.to || user.address;
    const ztoken = await hre.ethers.getContractAt("LaunchDotFunTokenWrapper", taskArguments.ztoken);
    const ztokenAddress = await ztoken.getAddress();

    const underlyingAddress = await ztoken.underlying();
    const underlying = await hre.ethers.getContractAt("IERC20", underlyingAddress);
    const [underlyingDecimals, wrapperDecimals, rateRaw] = await Promise.all([
      readTokenDecimals(hre, underlyingAddress, 18),
      ztoken.decimals(),
      ztoken.rate(),
    ]);
    const rate = BigInt(rateRaw.toString());
    const decimalsNumber = Number(wrapperDecimals);

    const amount = parseAmount(taskArguments.amount, underlyingDecimals, hre);
    if (amount <= 0n) {
      throw new Error("Amount must be greater than zero");
    }

    console.log(`Wrapping ${formatAmount(amount, underlyingDecimals, hre)} underlying tokens...`);
    console.log("From:", user.address);
    console.log("To:", to);
    console.log("Rate (underlying per confidential):", rate.toString());
    console.log("Wrapper decimals:", decimalsNumber);

    const expectedConfidential = amount / rate;
    console.log(
      "Expected confidential tokens:",
      formatAmount(expectedConfidential, decimalsNumber, hre),
    );

    // Check if user has enough underlying tokens
    const underlyingBalance = await underlying.balanceOf(user.address);
    if (underlyingBalance < amount) {
      throw new Error(
        `Insufficient underlying token balance. Have: ${formatAmount(underlyingBalance, underlyingDecimals, hre)}, Need: ${formatAmount(amount, underlyingDecimals, hre)}`,
      );
    }

    // Check allowance
    const allowance = await underlying.allowance(user.address, taskArguments.ztoken);
    if (allowance < amount) {
      console.log("Approving underlying tokens for wrapper contract...");
      const approveTx = await underlying.connect(user).approve(taskArguments.ztoken, amount);
      await approveTx.wait();
      console.log("✅ Approval completed");
    }

    // Wrap tokens
    console.log("Executing wrap...");
    const tx = await ztoken.connect(user).wrap(to, amount);
    await tx.wait();

    let clearBalanceAfter: bigint | null = null;
    if (to.toLowerCase() === user.address.toLowerCase()) {
      const balanceAfter = await ztoken.confidentialBalanceOf(to);
      clearBalanceAfter = await fhevm.userDecryptEuint(FhevmType.euint64, balanceAfter.toString(), ztokenAddress, user);
    } else {
      console.log("Recipient differs from sender. Skipping decrypted balance output.");
    }

    console.log("✅ Wrap completed successfully!");
    console.log("Wrapped amount:", formatAmount(amount, underlyingDecimals, hre));
    console.log("Confidential tokens minted:", formatAmount(expectedConfidential, decimalsNumber, hre));
    if (clearBalanceAfter !== null) {
      console.log("Recipient confidential balance:", formatAmount(clearBalanceAfter, decimalsNumber, hre));
    }

    return {
      from: user.address,
      to: to,
      wrappedAmount: amount,
      confidentialTokensReceived: expectedConfidential,
      rate: rate,
      newBalance: clearBalanceAfter,
    };
  });

/**
 * Unwrap confidential tokens back to underlying ERC20 tokens
 * Example: npx hardhat --network sepolia task:ztoken-unwrap --amount 10 --user 1 --ztoken 0x... --to 0x...
 */
task("task:ztoken-unwrap", "Unwrap confidential tokens back to underlying ERC20 tokens")
  .addParam("amount", "Amount of confidential tokens to unwrap")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addParam("ztoken", "LaunchDotFunTokenWrapper contract address")
  .addOptionalParam("to", "Recipient address for underlying tokens (defaults to user)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Unwrapping confidential tokens to underlying tokens...");

    // Initialize FHEVM
    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const to = taskArguments.to || user.address;
    const ztoken = await hre.ethers.getContractAt("LaunchDotFunTokenWrapper", taskArguments.ztoken);
    const ztokenAddress = await ztoken.getAddress();
    const [wrapperDecimals, rateRaw, underlyingAddress] = await Promise.all([
      ztoken.decimals(),
      ztoken.rate(),
      ztoken.underlying(),
    ]);
    const rate = BigInt(rateRaw.toString());
    const decimalsNumber = Number(wrapperDecimals);
    const amount = parseAmount(taskArguments.amount, decimalsNumber, hre);
    if (amount <= 0n) {
      throw new Error("Amount must be greater than zero");
    }

    const underlying = await hre.ethers.getContractAt("IERC20", underlyingAddress);
    const underlyingDecimals = await readTokenDecimals(hre, underlyingAddress, 18);

    console.log(`Unwrapping ${formatAmount(amount, decimalsNumber, hre)} confidential tokens...`);
    console.log("From:", user.address);
    console.log("To:", to);
    console.log("Rate:", rate.toString());
    console.log("Expected underlying tokens:", formatAmount(amount * rate, underlyingDecimals, hre));

    // Check if user has enough confidential tokens
    const balance = await ztoken.confidentialBalanceOf(user.address);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      ztokenAddress,
      user,
    );

    if (clearBalance < amount) {
      throw new Error(
        `Insufficient confidential token balance. Have: ${formatAmount(clearBalance, decimalsNumber, hre)}, Need: ${formatAmount(amount, decimalsNumber, hre)}`,
      );
    }

    // Get underlying token balance before unwrap
    const underlyingBalanceBefore = await underlying.balanceOf(to);

    // Create encrypted unwrap input
    console.log("Creating encrypted unwrap input...");
    const encrypted = await fhevm.createEncryptedInput(ztokenAddress, user.address).add64(amount).encrypt();

    // Unwrap tokens
    console.log("Executing unwrap...");
    const tx = await ztoken
      .connect(user)
      ["unwrap(address,address,bytes32,bytes)"](user.address, to, encrypted.handles[0], encrypted.inputProof);
    await tx.wait();

    // Get underlying token balance after unwrap
    const underlyingBalanceAfter = await underlying.balanceOf(to);
    const receivedUnderlying = underlyingBalanceAfter - underlyingBalanceBefore;

    console.log("✅ Unwrap completed successfully!");
    console.log("Confidential tokens burned:", formatAmount(amount, decimalsNumber, hre));
    console.log("Underlying tokens received:", formatAmount(receivedUnderlying, underlyingDecimals, hre));

    return {
      from: user.address,
      to: to,
      unwrappedAmount: receivedUnderlying,
      confidentialTokensBurned: amount,
      rate: rate,
    };
  });

/**
 * Get confidential token balance
 * Example: npx hardhat --network sepolia task:ztoken-balance --user 1 --ztoken 0x...
 */
task("task:ztoken-balance", "Get confidential token balance")
  .addParam("user", "User index (0, 1, 2, etc.)")
  .addParam("ztoken", "LaunchDotFunTokenWrapper contract address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Getting confidential token balance...");

    // Initialize FHEVM
    await fhevm.initializeCLIApi();

    const user = await getSigner(hre, parseInt(taskArguments.user));
    const ztoken = await hre.ethers.getContractAt("LaunchDotFunTokenWrapper", taskArguments.ztoken);
    const ztokenAddress = await ztoken.getAddress();

    // Get balance
    console.log("Getting confidential token balance of user...");
    const balance = await ztoken.confidentialBalanceOf(user.address);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      ztokenAddress,
      user,
    );

    // Get contract info for display
    const [name, symbol, decimals, rateRaw, underlyingAddress] = await Promise.all([
      ztoken.name(),
      ztoken.symbol(),
      ztoken.decimals(),
      ztoken.rate(),
      ztoken.underlying(),
    ]);
    const rate = BigInt(rateRaw.toString());
    const decimalsNumber = Number(decimals);

    console.log("👤 Confidential Token Balance:");
    console.log("User address:", user.address);
    console.log("Token name:", name);
    console.log("Token symbol:", symbol);
    console.log("Decimals:", decimalsNumber);
    console.log("Balance:", formatAmount(clearBalance, decimalsNumber, hre), symbol);
    console.log("Underlying token:", underlyingAddress);

    return {
      address: user.address,
      balance: clearBalance,
      name: name,
      symbol: symbol,
      decimals: decimalsNumber,
      rate: rate,
      underlying: underlyingAddress,
    };
  });

/**
 * Transfer confidential tokens between addresses
 * Example: npx hardhat --network sepolia task:ztoken-transfer --amount 5 --from 1 --to 0x... --ztoken 0x...
 */
task("task:ztoken-transfer", "Transfer confidential tokens between addresses")
  .addParam("amount", "Amount of confidential tokens to transfer")
  .addParam("from", "Sender user index (0, 1, 2, etc.)")
  .addParam("to", "Recipient address")
  .addParam("ztoken", "LaunchDotFunTokenWrapper contract address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { fhevm } = hre;

    console.log("Transferring confidential tokens...");

    // Initialize FHEVM
    await fhevm.initializeCLIApi();

    const fromUser = await getSigner(hre, parseInt(taskArguments.from));
    const toAddress = taskArguments.to;

    const ztoken = await hre.ethers.getContractAt("LaunchDotFunTokenWrapper", taskArguments.ztoken);
    const ztokenAddress = await ztoken.getAddress();

    // Get contract info
    const [symbol, decimals] = await Promise.all([ztoken.symbol(), ztoken.decimals()]);
    const decimalsNumber = Number(decimals);
    const amount = parseAmount(taskArguments.amount, decimalsNumber, hre);
    if (amount <= 0n) {
      throw new Error("Amount must be greater than zero");
    }

    const balance = await ztoken.confidentialBalanceOf(fromUser.address);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      ztokenAddress,
      fromUser,
    );
    if (clearBalance < amount) {
      throw new Error(
        `Insufficient balance. Have: ${formatAmount(clearBalance, decimalsNumber, hre)}, Need: ${formatAmount(amount, decimalsNumber, hre)}`,
      );
    }

    console.log(`Transferring ${formatAmount(amount, decimalsNumber, hre)} ${symbol}...`);
    console.log("From:", fromUser.address);
    console.log("To:", toAddress);

    // Create encrypted transfer input
    console.log("Creating encrypted transfer input...");
    const encrypted = await fhevm.createEncryptedInput(ztokenAddress, fromUser.address).add64(amount).encrypt();

    // Transfer tokens
    console.log("Executing transfer...");
    const tx = await ztoken
      .connect(fromUser)
      ["confidentialTransfer(address,bytes32,bytes)"](toAddress, encrypted.handles[0], encrypted.inputProof);
    await tx.wait();

    // Get balances after transfer
    const fromBalanceAfter = await ztoken.confidentialBalanceOf(fromUser.address);

    const fromClearBalanceAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      fromBalanceAfter.toString(),
      ztokenAddress,
      fromUser,
    );

    console.log("✅ Transfer completed successfully!");
    console.log("Transferred amount:", formatAmount(amount, decimalsNumber, hre));
    console.log("Sender new balance:", formatAmount(fromClearBalanceAfter, decimalsNumber, hre));

    return {
      from: fromUser.address,
      to: toAddress,
      transferredAmount: amount,
      senderNewBalance: fromClearBalanceAfter,
    };
  });
