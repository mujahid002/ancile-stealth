import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

// Load your staging environment variables
dotenv.config({ path: path.resolve(__dirname, '.env.staging') });

const ERC6538_REGISTRY_ADDRESS = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";

// The minimal ABI to read Bob's profile
const REGISTRY_ABI = [
    "function stealthMetaAddressOf(address registrant, uint256 schemeId) external view returns (bytes memory)"
];

async function verifyBobOnChain() {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL!;
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    
    // We don't need a wallet/signer because we are just reading data!
    const registryContract = new ethers.Contract(ERC6538_REGISTRY_ADDRESS, REGISTRY_ABI, provider);

    // Bob's main address that we used in the payload
    const bobAddress = "0xb5165E6B4066A4D68a2205752CC533f9D3c95B42";
    const schemeId = 1;

    console.log(`🔍 Querying Base Sepolia for Bob's Meta-Address...`);
    console.log(`👤 Address: ${bobAddress}`);

    try {
        const metaAddressBytes = await registryContract.stealthMetaAddressOf(bobAddress, schemeId);
        
        // If the contract returns '0x', it means he is not registered
        if (metaAddressBytes === "0x") {
            console.log(`\n❌ Result: Bob is NOT registered.`);
            console.log(`The inner transaction definitely reverted. We need to debug the EIP-712 signature or check if the contract is deployed.`);
        } else {
            console.log(`\n✅ SUCCESS! Bob IS registered on-chain!`);
            console.log(`📍 Meta-Address: ${metaAddressBytes}`);
        }
    } catch (error: any) {
        console.log(`\n🚨 CRITICAL ERROR: Could not read from the contract.`);
        console.log(`This usually means the contract is NOT deployed at ${ERC6538_REGISTRY_ADDRESS} on Base Sepolia.`);
        console.error(error.message);
    }
}

verifyBobOnChain().catch(console.error);
