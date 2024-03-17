/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/**
 * Associate bindings declared in wrangler.toml with the TypeScript type system
 */
export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	GPS_DISTANCE: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;

	CORS_ORIGIN: string;
}

type ParseResult = ParseSuccess | ParseFailure;
type ParseSuccess = {
	result: true;
	message: null;
	type: string;
	params: unknown;
};
type ParseFailure = {
	result: false;
	message: string;
};

type Metadata = {
	id: string;
	name: string;
};

type Data = {
	latitute: number;
	longitude: number;
	accuracy: number;
	altitude?: number;
	altitudeAccuracy?: number;
	lastUpdate: number;
};

type TypeOfTypes =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "array"
	| "bigint"
	| "symbol"
	| "function"
	| "undefined";

function generateRoomId() {
	const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

	const idIndex = new Uint8Array(10);
	crypto.getRandomValues(idIndex);

	return idIndex.reduce((acc, val) => {
		return acc + BASE36[val % 36];
	}, "");
}

async function createRoom(request: Request, env: Env) {
	for (let i = 0; i < 10; ++i) {
		const roomId = generateRoomId();
		const durableId = env.GPS_DISTANCE.idFromString(roomId);
		const room = env.GPS_DISTANCE.get(durableId);

		const existing = await room.fetch("exist", request);
		if (existing.status !== 200) {
			await room.fetch("create", request);

			return new Response(
				JSON.stringify({
					result: true,
					data: {
						roomId,
					},
				}),
			);
		}
	}

	return new Response(
		JSON.stringify({
			result: false,
			message: "Failed to create room",
		}),
		{ status: 503 },
	);
}

async function handleApiRequest(path: string[], request: Request, env: Env) {
	const headers = env.CORS_ORIGIN
		? {
				"Access-Control-Allow-Origin": env.CORS_ORIGIN,
				"Access-Control-Allow-Methods": request.method,
				"Access-Control-Allow-Credentials": "true",
				Vary: "Origin",
		  }
		: undefined;

	if (path[0] === "room") {
		if (path.length === 1) {
			if (request.method === "POST") {
				return await createRoom(request, env);
			}
			return new Response(
				JSON.stringify({
					result: false,
					message: "Method not allowed",
				}),
				{
					status: 405,
					headers,
				},
			);
		}

		if (path.length === 2) {
			const roomId = path[1].toLowerCase();
			if (!/^[0-9a-z]{3}-[0-9a-z]{4}-[0-9a-z]{3}$/.test(roomId)) {
				return new Response(
					JSON.stringify({
						result: false,
						message: "Invalid room id",
					}),
					{ status: 400, headers },
				);
			}

			const durableId = env.GPS_DISTANCE.idFromString(roomId);
			const room = env.GPS_DISTANCE.get(durableId);

			return room.fetch("", request);
		}
	}

	return new Response(
		JSON.stringify({
			result: false,
			message: "Not found",
		}),
		{ status: 404, headers },
	);
}

/** A Durable Object's behavior is defined in an exported Javascript class */
export class GpsDistanceDurableObject {
	private state: DurableObjectState;
	private storage: DurableObjectStorage;
	private env: Env;
	private sessions: Map<WebSocket, Metadata>;

	private initialized = false;

	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier
	 *
	 * @param state - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.toml
	 */
	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.storage = state.storage;
		this.env = env;
		this.sessions = new Map<WebSocket, Metadata>();

		for (const ws of this.state.getWebSockets()) {
			const meta = ws.deserializeAttachment();
			this.sessions.set(ws, meta as Metadata);
		}

		this.initialized = this.state.getWebSockets().length !== 0;
	}

	/**
	 * The Durable Object fetch handler will be invoked when a Durable Object instance receives a
	 * 	request from a Worker via an associated stub
	 *
	 * @param request - The request submitted to a Durable Object instance from a Worker
	 * @returns The response to be sent back to the Worker
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "") {
			const upgrade = request.headers.get("Upgrade");
			if (!upgrade || upgrade !== "websocket") {
				return new Response(
					JSON.stringify({
						result: false,
						message: "Expected websocket connection",
					}),
					{ status: 426 },
				);
			}

			const websocket = new WebSocketPair();
			const [client, server] = Object.values(websocket);

			this.state.acceptWebSocket(server);

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		if (url.pathname === "exist") {
			if (this.initialized) {
				return new Response(null, { status: 200 });
			}
			return new Response(null, { status: 404 });
		}

		if (url.pathname === "create") {
			this.initialized = true;
			return new Response(null, { status: 200 });
		}

		return new Response(
			JSON.stringify({
				result: false,
				message: "Not found",
			}),
			{ status: 404 },
		);
	}

	parseMessage(message: string): ParseResult {
		let data: unknown = null;

		try {
			data = JSON.parse(message);
		} catch (e: unknown) {
			if (e instanceof SyntaxError) {
				return {
					result: false,
					message: "Malformed JSON",
				};
			}
			return {
				result: false,
				message: "Unknown error occurred",
			};
		}

		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			return {
				result: false,
				message: "Invalid Payload",
			};
		}

		if (!("type" in data)) {
			return {
				result: false,
				message: "Invalid Payload",
			};
		}

		const { type, ...params } = data;

		if (typeof type !== "string") {
			return {
				result: false,
				message: "Invalid Payload",
			};
		}

		return {
			result: true,
			message: null,
			type,
			params,
		};
	}

	async webSocketMessage(ws: WebSocket, messageRaw: string | ArrayBuffer) {
		const message =
			typeof messageRaw === "string"
				? messageRaw
				: new TextDecoder().decode(messageRaw);

		const payload = this.parseMessage(message);
		if (!payload.result) {
			ws.send(
				JSON.stringify({
					result: false,
					message: payload.message,
				}),
			);
			ws.close();
			return;
		}

		const { type, params } = payload;
		if (
			typeof params !== "object" ||
			params === null ||
			Array.isArray(params)
		) {
			ws.send(
				JSON.stringify({
					result: false,
					message: "Invalid Payload",
				}),
			);
			ws.close();
			return;
		}

		if (type === "join") {
			if (!("name" in params) || typeof params.name !== "string") {
				ws.send(
					JSON.stringify({
						result: false,
						message: "Invalid Payload",
					}),
				);
				ws.close();
				return;
			}

			const id = crypto.randomUUID();
			ws.serializeAttachment({ id, name: params.name });
			this.sessions.set(ws, { id, name: params.name });

			const data = [];
			for (const sessions of this.sessions.values()) {
				data.push({ sessions, data: this.storage.get(sessions.id) });
			}

			ws.send(
				JSON.stringify({
					result: true,
					data,
				}),
			);
		}
		if (type === "update") {
			if (!("latitute" in params) || typeof params.latitute !== "number") {
				ws.send(
					JSON.stringify({
						result: false,
						message: "Invalid Payload",
					}),
				);
				ws.close();
				return;
			}

			if (!("longitude" in params) || typeof params.longitude !== "number") {
				ws.send(
					JSON.stringify({
						result: false,
						message: "Invalid Payload",
					}),
				);
				ws.close();
				return;
			}

			if (!("accuracy" in params) || typeof params.accuracy !== "number") {
				ws.send(
					JSON.stringify({
						result: false,
						message: "Invalid Payload",
					}),
				);
				ws.close();
				return;
			}

			if (!("update" in params) || typeof params.update !== "number") {
				ws.send(
					JSON.stringify({
						result: false,
						message: "Invalid Payload",
					}),
				);
				ws.close();
				return;
			}

			const altitude = (() => {
				if ("altitude" in params) {
					if (typeof params.altitude !== "number") {
						return undefined;
					}
					return params.altitude;
				}
				return undefined;
			})();

			const altitudeAccuracy = (() => {
				if ("altitudeAccuracy" in params) {
					if (typeof params.altitudeAccuracy !== "number") {
						return undefined;
					}
					return params.altitudeAccuracy;
				}
				return undefined;
			})();

			const meta = this.sessions.get(ws);
			if (meta === undefined) {
				ws.send(
					JSON.stringify({
						result: false,
						message: "Unregistered session",
					}),
				);
				ws.close();
				return;
			}

			const newData: Data = {
				latitute: params.latitute,
				longitude: params.longitude,
				accuracy: params.accuracy,
				lastUpdate: params.update,
				altitude,
				altitudeAccuracy,
			};
			this.storage.put(meta.id, newData);

			this.broadcast(meta.id, newData);
		}
	}

	async broadcast(id: string, data?: Data) {
		const message = JSON.stringify({ id, data });

		const disconnected = [];

		for (const ws of this.sessions.keys()) {
			try {
				ws.send(message);
			} catch {
				disconnected.push(ws);
				this.sessions.delete(ws);
			}
		}

		for (const ws of disconnected) {
			this.webSocketClose(ws);
			this.broadcast(id);
		}
	}

	async webSocketClose(ws: WebSocket) {
		const session = this.sessions.get(ws);
		this.sessions.delete(ws);
		if (session !== undefined) {
			this.storage.delete(session.id);
			this.broadcast(session.id);
		}
	}

	async webSocketError(ws: WebSocket) {
		const session = this.sessions.get(ws);
		this.sessions.delete(ws);
		if (session !== undefined) {
			this.storage.delete(session.id);
			this.broadcast(session.id);
		}
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.toml
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.slice(1).split("/");

		if (path[0] === "api") {
			return handleApiRequest(path.slice(1), request, env);
		}

		return new Response("Not Found", { status: 404 });
	},
};
