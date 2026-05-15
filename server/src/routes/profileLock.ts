import { getServerByName } from "partyserver";
import { isProfileLockDTO, type ProfileLockDTO } from "../profileLockStore";
import type { Env, JsonResponse } from "./types";

const LOG_PREFIX = "[yaos-sync:worker]";

interface ProfileLockPutBody {
	baseGeneration?: unknown;
	nextLock?: unknown;
}

export async function handleProfileLockRoute(
	env: Env,
	vaultId: string,
	req: Request,
	rest: string[],
	json: JsonResponse,
): Promise<Response> {
	if (rest.length > 0) {
		return json({ error: "not found" }, 404);
	}

	const stub = await getServerByName(env.YAOS_SYNC, vaultId);

	if (req.method === "GET") {
		const downstream = await stub.fetch("https://internal/__yaos/profile-lock", {
			method: "GET",
		});
		return new Response(downstream.body, {
			status: downstream.status,
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
	}

	if (req.method === "PUT") {
		let body: ProfileLockPutBody;
		try {
			body = (await req.json()) as ProfileLockPutBody;
		} catch {
			return json({ error: "invalid json" }, 400);
		}

		if (typeof body.baseGeneration !== "string") {
			return json({ error: "missing baseGeneration" }, 400);
		}
		if (!isProfileLockDTO(body.nextLock)) {
			return json({ error: "invalid nextLock" }, 400);
		}

		const payload: { baseGeneration: string; nextLock: ProfileLockDTO } = {
			baseGeneration: body.baseGeneration,
			nextLock: body.nextLock,
		};

		const downstream = await stub.fetch("https://internal/__yaos/profile-lock", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		return new Response(downstream.body, {
			status: downstream.status,
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
	}

	return json({ error: "method not allowed" }, 405);
}

void LOG_PREFIX;
