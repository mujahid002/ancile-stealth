import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { defineConfig } from "hardhat/config";
import dotenv from "dotenv";

dotenv.config();

export default defineConfig({
  plugins: [
    hardhatToolboxMochaEthersPlugin, 
    hardhatVerify
  ],
  solidity: {
    profiles: {
      default: { version: "0.8.28" },
      production: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    hardhatOp: { type: "edr-simulated", chainType: "op" },
    baseSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_SEPOLIA_RPC_URL as string,
      accounts: [process.env.CRE_PRIVATE_KEY as string],
      chainId: 84532,
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.BASESCAN_API_KEY as string,
    },
  },
  chainDescriptors: {
    84532: {
      name: "Base Sepolia",
      blockExplorers: {
        etherscan: {
          url: "https://sepolia.basescan.org",
          apiUrl: "https://api.etherscan.io/v2/api",
        },
      },
    },
  },
});
