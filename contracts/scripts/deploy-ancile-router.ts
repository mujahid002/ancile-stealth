import { network } from "hardhat";
const { ethers } = await network.connect();
import config from "../../config.p2p.json";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);

    // ==========================================
    // 1. DEPLOY & MINT TOKEN A (mUSDC FOR ALICE)
    // ==========================================
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const tokenA = await MockUSDC.deploy("MockUSDC", "mUSDC", deployer.address);
    await tokenA.waitForDeployment();
    const tokenAAddress = await tokenA.getAddress();
    
    // Alice gets 1,000 mUSDC
    const mintAmountA = ethers.parseUnits("1000", 6);
    await (await (tokenA as any).mint(config.ALICE_PUBLIC_ADDRESS, mintAmountA)).wait();
    console.log("✅ Minted 1,000 mUSDC to Alice at:", tokenAAddress);

    // ==========================================
    // 2. DEPLOY & MINT TOKEN B (mWLD FOR BOB)
    // ==========================================
    const MockWLD = await ethers.getContractFactory("MockWLD");
    const tokenB = await MockWLD.deploy("MockWLD", "mWLD", deployer.address);
    await tokenB.waitForDeployment();
    const tokenBAddress = await tokenB.getAddress();

    // Bob gets 500 mWLD (Using 6 decimals as defined in your mock contract)
    const mintAmountB = ethers.parseUnits("500", 6);
    await (await (tokenB as any).mint(config.BOB_PUBLIC_ADDRESS, mintAmountB)).wait();
    console.log("✅ Minted 500 mWLD to Bob at:", tokenBAddress);

    // ==========================================
    // 3. DEPLOY ANCILE ROUTER
    // ==========================================
    const forwarderAddress = config.FORWARDER_BASE_SEPOLIA;
    const AncileRouter = await ethers.getContractFactory("AncileRouter");

    const router = await AncileRouter.deploy(
        forwarderAddress,
        config.REGISTRY_ADDRESS,
        deployer.address
    );  
    await router.waitForDeployment();
    const routerAddress = await router.getAddress();
    console.log("✅ AncileRouter deployed to:", routerAddress);

    // ==========================================
    // 4. ROUTER SETUP
    // ==========================================
    let tx = await (router as any).bobSetup(config.BOB_PUBLIC_ADDRESS, config.CURRENT_SCHEME_ID_FOR_BOB, 1);
    await tx.wait();
    console.log("✅ Bob setup complete! Tx:", tx.hash);
    tx = await (router as any).bobSetup(config.ALICE_PUBLIC_ADDRESS, config.CURRENT_SCHEME_ID_FOR_BOB, 1);
    await tx.wait();
    console.log("✅ Alice setup complete! Tx:", tx.hash);

    // ==========================================
    // 5. SUMMARY (COPY THESE TO YOUR CONFIG)
    // ==========================================
    console.log("\n🔥 --- DEPLOYMENT SUMMARY --- 🔥");
    console.log(`"ROUTER_ADDRESS": "${routerAddress}",`);
    console.log(`"MOCK_USDC_ADDRESS": "${tokenAAddress}", // This is mUSDC`);
    console.log(`"MOCK_WLD_ADDRESS": "${tokenBAddress}", // This is mWLD (Update your config key if needed)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});