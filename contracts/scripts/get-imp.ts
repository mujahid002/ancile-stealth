import { network } from "hardhat";
const { ethers } = await network.connect();
import config from "../../config.json";

async function main() {
    const PROXY_ADDRESS = config.ROUTER_ADDRESS;
    // This is the standard EIP-1967 implementation slot
    const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    
    const implementationAddress = await ethers.provider.getStorage(PROXY_ADDRESS, implSlot);
    
    // The result is a 32-byte hex string, we need the last 20 bytes (the address)
    const cleanAddress = ethers.getAddress("0x" + implementationAddress.slice(26));
    
    console.log("Found Implementation Address:", cleanAddress);
}

main();