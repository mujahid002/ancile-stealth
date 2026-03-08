import { network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { AbiCoder, Interface } from "ethers";
import config from "../../config.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMPL_ADDRESS = config.IMPLEMENATION_ADDRESS;
const PROXY_ADDRESS = config.ROUTER_ADDRESS;
const FORWARDER = config.FORWARDER_BASE_SEPOLIA;
const REGISTRY = config.REGISTRY_ADDRESS;

function loadBuildInfo(): { compilerInput: any; compilerVersion: string } {
    const buildInfoDir = path.resolve(__dirname, "../artifacts/build-info");
    if (!fs.existsSync(buildInfoDir)) {
        throw new Error("No artifacts found. Run: npx hardhat compile");
    }
    const files = fs.readdirSync(buildInfoDir)
        .filter(f => f.endsWith(".json") && !f.endsWith(".output.json"));

    for (const file of files) {
        const raw = JSON.parse(fs.readFileSync(path.join(buildInfoDir, file), "utf-8"));

        const sources = raw.input?.sources || {};
        const foundKey = Object.keys(sources).find(key => key.endsWith("AncileRouter.sol"));

        if (foundKey) {
            const ver = raw.solcLongVersion as string;
            return { compilerInput: raw.input, compilerVersion: ver.startsWith("v") ? ver : `v${ver}` };
        }
    }
    throw new Error("AncileRouter not found in any build-info. Run: npx hardhat compile");
}

function encodeProxyConstructorArgs(implAddress: string, initData: string): string {
    return AbiCoder.defaultAbiCoder()
        .encode(["address", "bytes"], [implAddress, initData])
        .slice(2);
}

async function main() {
    if (!IMPL_ADDRESS) throw new Error("Missing ROUTER_IMPL_ADDRESS — add it to config.json or set IMPL_ADDRESS env var");
    if (!PROXY_ADDRESS) throw new Error("Missing ROUTER_ADDRESS in config.json");

    const { ethers, verification } = await network.connect();
    const etherscan = verification.etherscan;

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);

    console.log(`\n📡 Basescan API: ${await etherscan.getApiUrl()}`);

    const { compilerInput, compilerVersion } = loadBuildInfo();
    console.log(`🛠  Compiler: ${compilerVersion}`);

    // Encode initialize(forwarder, registry, owner) for proxy constructor arg
    const iface = new Interface(["function initialize(address forwarder, address registry, address owner)"]);
    const initData = iface.encodeFunctionData("initialize", [FORWARDER, REGISTRY, deployer.address]);

    // Verify Implementation (no constructor args: UUPS pattern)
    console.log(`\n🔍 Verifying AncileRouter implementation at ${IMPL_ADDRESS} ...`);
    if (await etherscan.isVerified(IMPL_ADDRESS)) {
        console.log("✅ Implementation already verified.");
    } else {
        try {
            const guid = await etherscan.verify({
                contractAddress: IMPL_ADDRESS,
                contractName: "contracts/AncileRouter.sol:AncileRouter",
                compilerInput,
                compilerVersion,
                constructorArguments: "",
            });
            console.log(`⏳ Polling verification status (GUID: ${guid}) ...`);
            const { success, message } = await etherscan.pollVerificationStatus(guid, IMPL_ADDRESS, "AncileRouter");
            console.log(success ? "✅ Implementation verified!" : `❌ ${message}`);
        } catch (e: any) {
            console.error("❌ Implementation error:", e.message ?? e);
        }
    }

    // Verify ERC1967Proxy
    console.log(`\n🔍 Verifying ERC1967Proxy (ProxyImport) at ${PROXY_ADDRESS} ...`);
    if (await etherscan.isVerified(PROXY_ADDRESS)) {
        console.log("✅ Proxy already verified.");
    } else {
        try {
            const guid = await etherscan.verify({
                contractAddress: PROXY_ADDRESS,
                contractName: "contracts/ProxyImport.sol:ProxyImport",
                compilerInput,
                compilerVersion,
                constructorArguments: encodeProxyConstructorArgs(IMPL_ADDRESS, initData),
            });
            console.log(`⏳ Polling verification status (GUID: ${guid}) ...`);
            const { success, message } = await etherscan.pollVerificationStatus(guid, PROXY_ADDRESS, "ProxyImport");
            console.log(success ? "✅ Proxy verified!" : `❌ ${message}`);
        } catch (e: any) {
            console.error("❌ Proxy error:", e.message ?? e);
        }
    }

    console.log("\n🎉 DONE:");
    console.log(`   Implementation : https://sepolia.basescan.org/address/${IMPL_ADDRESS}#code`);
    console.log(`   Proxy          : https://sepolia.basescan.org/address/${PROXY_ADDRESS}#code`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
