import { network } from "hardhat";
const { ethers } = await network.connect();
import config from "../../config.json";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);

    // ==========================================
    // DEPLOY & MINT TOKEN A (mUSDC FOR ALICE)
    // ==========================================
    console.log("\n🪙 Deploying MockUSDC...");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const tokenA = await MockUSDC.deploy("MockUSDC", "mUSDC", deployer.address);
    await tokenA.waitForDeployment();
    const tokenAAddress = await tokenA.getAddress();
    
    // Alice gets 1M mUSDC
    const mintAmountA = ethers.parseUnits("1000000", 6);
    await (await (tokenA as any).mint(config.ALICE_PUBLIC_ADDRESS, mintAmountA)).wait();
    console.log("✅ Minted 1M mUSDC to Alice at:", tokenAAddress);

    // ==========================================
    // DEPLOY & MINT TOKEN B (mWLD FOR BOB)
    // ==========================================
    console.log("\n🪙 Deploying MockWLD...");
    const MockWLD = await ethers.getContractFactory("MockWLD");
    const tokenB = await MockWLD.deploy("MockWLD", "mWLD", deployer.address);
    await tokenB.waitForDeployment();
    const tokenBAddress = await tokenB.getAddress();

    // Bob gets 1M mWLD
    const mintAmountB = ethers.parseUnits("1000000", 6);
    await (await (tokenB as any).mint(config.BOB_PUBLIC_ADDRESS, mintAmountB)).wait();
    console.log("✅ Minted 1M mWLD to Bob at:", tokenBAddress);

    // const tokenAAddress = config.MOCK_USDC_ADDRESS;
    // const tokenBAddress = config.MOCK_WLD_ADDRESS;

    // ==========================================
    // DEPLOY ANCILE ROUTER IMPLEMENTATION
    // ==========================================
    console.log("\n🚀 Deploying AncileRouter Implementation...");
    const AncileRouter = await ethers.getContractFactory("AncileRouter");

    const impl = await AncileRouter.deploy();
    
    await impl.waitForDeployment();
    const implAddress = await impl.getAddress();
    console.log("✅ Implementation deployed to:", implAddress);

    // ==========================================
    // DEPLOY ERC1967 PROXY & INITIALIZE
    // ==========================================
    console.log("\n🚀 Deploying ERC1967Proxy...");
    
    // Encode the initialization data
    const forwarderAddress = config.FORWARDER_BASE_SEPOLIA;
    const initData = AncileRouter.interface.encodeFunctionData("initialize", [
        forwarderAddress,
        config.REGISTRY_ADDRESS,
        deployer.address
    ]);

    // Deploy the standard OpenZeppelin Proxy pointing to our implementation
    const ERC1967Proxy = await ethers.getContractFactory("ProxyImport");
    const proxy = await ERC1967Proxy.deploy(implAddress, initData);
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();
    console.log("✅ Proxy deployed to:", proxyAddress);

    // ==========================================
    // ROUTER SETUP (VIA PROXY)
    // ==========================================
    console.log("\n⚙️ Configuring accounts...");
    // Attach the AncileRouter ABI to the newly deployed Proxy address
    const router = await ethers.getContractAt("AncileRouter", proxyAddress);

    let tx = await (router as any).accountSetup(config.BOB_PUBLIC_ADDRESS, config.ANCILE_SCHEME_ID_FOR_ACCOUNT_SETUP, 1);
    await tx.wait();
    console.log("✅ Bob setup complete! Tx:", tx.hash);

    tx = await (router as any).accountSetup(config.ALICE_PUBLIC_ADDRESS, config.ANCILE_SCHEME_ID_FOR_ACCOUNT_SETUP, 1);
    await tx.wait();
    console.log("✅ Alice setup complete! Tx:", tx.hash);

    console.log("\n🔥 --- DEPLOYMENT SUMMARY --- 🔥");
    console.log(`"ROUTER_ADDRESS": "${proxyAddress}", // <-- Paste these into config.json`);
    console.log(`"MOCK_USDC_ADDRESS": "${tokenAAddress}",`);
    console.log(`"MOCK_WLD_ADDRESS": "${tokenBAddress}",`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
