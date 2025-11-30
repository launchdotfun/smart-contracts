import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;

  console.log("Deployer address:", deployer);

  const zwethDeployment = await get("LaunchDotFunWETH");
  const zwethAddress = zwethDeployment.address;
  console.log("Using LaunchDotFunWETH address:", zwethAddress);

  const tokenFactoryDeployment = await get("LaunchDotFunTokenFactory");
  const tokenFactoryAddress = tokenFactoryDeployment.address;
  console.log("Using LaunchDotFunTokenFactory address:", tokenFactoryAddress);

  const factory = await deploy("LaunchDotFunPresaleFactory", {
    from: deployer,
    log: true,
    args: [zwethAddress, tokenFactoryAddress],
  });

  console.log(`LaunchDotFunPresaleFactory deployed at:`, factory.address);
};
export default func;
func.id = "deploy_launchdotfunPresaleFactory"; // id required to prevent reexecution
func.tags = ["LaunchDotFunPresaleFactory"];

