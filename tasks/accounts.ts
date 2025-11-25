import { task } from "hardhat/config";

import { formatAmount } from "./helpers";

task("accounts", "Prints the list of accounts")
  .addFlag("balances", "Include ETH balances for each signer")
  .setAction(async function (taskArgs, hre) {
    const includeBalances = Boolean(taskArgs.balances);
    const accounts = await hre.ethers.getSigners();

    console.log(`Total available signers: ${accounts.length}`);

    const rows = [];
    for (const [index, account] of accounts.entries()) {
      const row: Record<string, string> = {
        index: index.toString(),
        address: account.address,
      };

      if (includeBalances) {
        const balance = await hre.ethers.provider.getBalance(account.address);
        row.eth = `${formatAmount(balance, 18, hre)} ETH`;
      }

      rows.push(row);
    }

    console.table(rows);
  });
