import type { HardhatRuntimeEnvironment } from "hardhat/types";

export async function getSigner(hre: HardhatRuntimeEnvironment, index: number) {
  const signers = await hre.ethers.getSigners();
  if (index < 0 || index >= signers.length) {
    throw new Error(`User index ${index} out of range. Available indexes: 0-${signers.length - 1}`);
  }
  return signers[index];
}

export function parseAmount(amount: string, decimals: number, hre: HardhatRuntimeEnvironment): bigint {
  return hre.ethers.parseUnits(amount, decimals);
}

export function formatAmount(amount: bigint, decimals: number, hre: HardhatRuntimeEnvironment): string {
  return hre.ethers.formatUnits(amount, decimals);
}

