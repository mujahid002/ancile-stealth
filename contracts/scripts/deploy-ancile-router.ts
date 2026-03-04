import { network } from "hardhat";
const { ethers } = await network.connect();
import config from "../../config.json";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);

    const MockToken = await ethers.getContractFactory("MockToken");
    const token = await MockToken.deploy("Mock USDC", "mUSDC", deployer.address);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    // const tokenAddress = config.TOKEN_ADDRESS;
    console.log("MockToken (mUSDC):", tokenAddress);

    const mintAmount = ethers.parseUnits("1000", 6);
    const tokenWithMint = token as Awaited<ReturnType<typeof MockToken.deploy>> & {
        mint(to: string, amount: bigint): Promise<{ wait: () => Promise<unknown> }>;
    };
    await (await tokenWithMint.mint(config.ALICE_PUBLIC_ADDRESS as `0x${string}`, mintAmount)).wait();
    console.log("Minted 1,000 mUSDC to Alice");

    const forwarderAddress = config.FORWARDER_BASE_SEPOLIA;
    const AncileVaultRouter = await ethers.getContractFactory("AncileRouter");

    // World ID is verified in CRE via API; contract only needs forwarder, registry, admin
    const router = await (AncileVaultRouter as any).deploy(
        forwarderAddress,
        config.REGISTRY_ADDRESS,
        deployer.address
    );  
    await router.waitForDeployment();
    const routerAddress = await router.getAddress();
    console.log("AncileVaultRouter deployed (use this as router):", routerAddress);

    console.log("\n---");
    console.log("Router (receiver):", routerAddress);
    console.log("Token:", tokenAddress);
    console.log("Alice:", config.ALICE_PUBLIC_ADDRESS);
    console.log("Bob:", config.BOB_PUBLIC_ADDRESS);
    console.log("\nNext: set receiverAddress / ROUTER_ADDRESS to", routerAddress);

    const tx = await router.bobSetup(config.BOB_PUBLIC_ADDRESS, config.CURRENT_SCHEME_ID_FOR_BOB, 1);
    await tx.wait();
    console.log("Bob setup tx:", tx.hash);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
