/**
 * .obsidian-mobile folder preparation.
 *
 * The mobile profile must be:
 *   - editable on the PC (so agents can review/touch mobile settings
 *     without depending on the phone being online);
 *   - bootable on the phone after the user MANUALLY enables Override
 *     config folder.
 *
 * This module computes the deterministic list of FS operations needed
 * to prepare the folder. It NEVER touches global Obsidian settings —
 * the Override config folder switch is the user's call.
 */

export const OBSIDIAN_MOBILE_DIR = ".obsidian-mobile";

/**
 * Bootstrap files that must exist inside .obsidian-mobile/plugins/<id>/
 * for YAOS to be loadable on first boot. We do not bring code from the
 * desktop — that comes from the live BRAT install on the phone — but we
 * DO seed the data.json so the plugin can survive the first session.
 */
export const BOOTSTRAP_PLUGIN_DATA_SEEDS: ReadonlyArray<{
	pluginId: string;
	defaultDataJson: unknown;
}> = [
	{ pluginId: "yaos", defaultDataJson: {} },
	{ pluginId: "obsidian42-brat", defaultDataJson: {} },
];

export interface MobileFolderInput {
	/** Already-applied profile manifest paths in the configDir. */
	currentDesktopFiles: ReadonlyArray<string>;
	/** Files already present inside .obsidian-mobile (relative to that dir). */
	existingMobileFiles: ReadonlyArray<string>;
	/** Whether YAOS data is present locally — if yes, we MUST preserve it. */
	yaosDataPresentInsideMobile: boolean;
}

export type FsOp =
	| { kind: "ensureDir"; path: string }
	| { kind: "writeJson"; path: string; value: unknown }
	| { kind: "preserve"; path: string }
	| { kind: "instruct-user"; message: string };

const USER_INSTRUCTION =
	"Open Settings → Files and links → Override config folder, " +
	"set it to '.obsidian-mobile', then restart Obsidian on the device.";

/** Deterministic plan to bring .obsidian-mobile up to a bootable state. */
export function planMobileFolderPreparation(input: MobileFolderInput): FsOp[] {
	const ops: FsOp[] = [];
	ops.push({ kind: "ensureDir", path: OBSIDIAN_MOBILE_DIR });
	ops.push({ kind: "ensureDir", path: `${OBSIDIAN_MOBILE_DIR}/plugins` });

	for (const seed of BOOTSTRAP_PLUGIN_DATA_SEEDS) {
		const dir = `${OBSIDIAN_MOBILE_DIR}/plugins/${seed.pluginId}`;
		const dataPath = `${dir}/data.json`;
		ops.push({ kind: "ensureDir", path: dir });
		const isYaos = seed.pluginId === "yaos";
		const alreadyExists = input.existingMobileFiles.includes(`plugins/${seed.pluginId}/data.json`);
		if (isYaos && input.yaosDataPresentInsideMobile) {
			ops.push({ kind: "preserve", path: dataPath });
			continue;
		}
		if (alreadyExists) {
			ops.push({ kind: "preserve", path: dataPath });
			continue;
		}
		ops.push({ kind: "writeJson", path: dataPath, value: seed.defaultDataJson });
	}

	ops.push({ kind: "instruct-user", message: USER_INSTRUCTION });
	return ops;
}

/**
 * Tag for any global Obsidian setting that the command MUST NOT touch.
 * Used by tests as a tripwire — if the planner ever returns an op that
 * mentions one of these, the test will catch it and fail.
 */
export const FORBIDDEN_GLOBAL_KEYS: ReadonlyArray<string> = [
	"obsidianMobileOverrideConfigFolder",
	"obsidianGlobalConfig",
	"appConfig",
];
