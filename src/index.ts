import process from "node:process";
import { cli, define } from "gunshi";
import authCommand from "./commands/auth.ts";
import doctorCommand from "./commands/doctor.ts";
import installCommand from "./commands/install.ts";
import setupCommand from "./commands/setup.ts";
import shellInitCommand from "./commands/shell-init.ts";
import statusCommand from "./commands/status.ts";
import statuslineCommand from "./commands/statusline.ts";
import syncCommand from "./commands/sync.ts";
import uninstallCommand from "./commands/uninstall.ts";

// Entry command: no `run` so gunshi renders the help/usage by default.
const rootCommand = define({
	name: "token-racer",
	description:
		"Monitor LLM tool usage, sign batches with Ed25519, and push to the token-racer backend.",
});

const subCommands = new Map([
	["setup", setupCommand],
	["auth", authCommand],
	["install", installCommand],
	["uninstall", uninstallCommand],
	["sync", syncCommand],
	["status", statusCommand],
	["doctor", doctorCommand],
	["statusline", statuslineCommand],
	["shell-init", shellInitCommand],
]);

await cli(process.argv.slice(2), rootCommand, {
	name: "token-racer",
	version: "0.1.0",
	description:
		"Monitor LLM tool usage, sign batches with Ed25519, and push to the token-racer backend.",
	subCommands,
	renderHeader: null,
});
