import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  console.log("Deployer address:", deployer);

  const tokenFactory = await deploy("LaunchDotFunTokenFactory", {
    from: deployer,
    log: true,
  });
  console.log(`LaunchDotFunTokenFactory deployed at:`, tokenFactory.address);

  if (tokenFactory.address) {
    console.log("✅ LaunchDotFunTokenFactory deployment successful!");
    console.log("📋 Contract Address:", tokenFactory.address);
    console.log("🔗 Transaction Hash:", tokenFactory.transactionHash);
  } else {
    console.log("❌ LaunchDotFunTokenFactory deployment failed!");
  }
};

export default func;
func.id = "deploy_launchdotfunTokenFactory";
func.tags = ["LaunchDotFunTokenFactory"];

