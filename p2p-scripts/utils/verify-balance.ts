import { ethers } from "ethers";
import config from "../../config.p2p.json";


async function verifyAliceBalance() {
    const provider = new ethers.providers.JsonRpcProvider(config.BASE_SEPOLIA_RPC_URL);
    const tokenContract = new ethers.Contract(config.TOKEN_ADDRESS, [
        "function balanceOf(address account) external view returns (uint256)"
    ], provider);
    const balance = await tokenContract.balanceOf(config.ALICE_PUBLIC_ADDRESS as `0x${string}`);
    console.log(`🔍 Alice's balance: ${ethers.utils.formatUnits(balance, 6)} mUSDC`);

    const bobBalance = await tokenContract.balanceOf(config.BOB_PUBLIC_ADDRESS as `0x${string}`);
    console.log(`🔍 Bob's balance: ${ethers.utils.formatUnits(bobBalance, 6)} mUSDC`);
}

verifyAliceBalance().catch(console.error);
