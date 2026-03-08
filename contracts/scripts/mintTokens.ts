import { network } from "hardhat";
const { ethers } = await network.connect();
import config from "../../config.json";

const MINT_AMOUNT = ethers.parseUnits("1000000", 6); // 1,000,000 tokens (6 decimals)

const ERC20_MINT_ABI = [
    "function mint(address to, uint256 amount) external",
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)"
];

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer (owner):", deployer.address);

    const usdc = new ethers.Contract(config.MOCK_USDC_ADDRESS, ERC20_MINT_ABI, deployer);
    const wld  = new ethers.Contract(config.MOCK_WLD_ADDRESS,  ERC20_MINT_ABI, deployer);

    // ==========================================
    // MINT mUSDC -> ALICE
    // ==========================================
    console.log("\n🪙 Minting 1,000,000 mUSDC to Alice...");
    let tx = await usdc.mint(config.ALICE_PUBLIC_ADDRESS, MINT_AMOUNT);
    await tx.wait();
    const aliceUsdc = await usdc.balanceOf(config.ALICE_PUBLIC_ADDRESS);
    console.log(`✅ Alice mUSDC balance: ${ethers.formatUnits(aliceUsdc, 6)} mUSDC  (tx: ${tx.hash})`);

    // ==========================================
    // MINT mWLD -> BOB
    // ==========================================
    console.log("\n🪙 Minting 1,000,000 mWLD to Bob...");
    tx = await wld.mint(config.BOB_PUBLIC_ADDRESS, MINT_AMOUNT);
    await tx.wait();
    const bobWld = await wld.balanceOf(config.BOB_PUBLIC_ADDRESS);
    console.log(`✅ Bob mWLD balance: ${ethers.formatUnits(bobWld, 6)} mWLD  (tx: ${tx.hash})`);

    console.log("\n🔥 Mint complete.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
