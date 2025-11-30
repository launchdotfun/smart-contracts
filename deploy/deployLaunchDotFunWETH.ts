import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  console.log("Deployer address:", deployer);

  const deployedCWETH = await deploy("LaunchDotFunWETH", {
    from: deployer,
    log: true,
  });

  console.log(`LaunchDotFunWETH deployed at:`, deployedCWETH.address);
};

export default func;
func.id = "deploy_launchdotfunWETH";
func.tags = ["LaunchDotFunWETH"];

