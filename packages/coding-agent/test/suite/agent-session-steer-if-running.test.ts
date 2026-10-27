import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function waitTool(): { tool: AgentTool; started: Promise<void>; release: () => void } {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		tool: {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await released.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		},
		started: started.promise,
		release: () => released.resolve(),
	};
}

describe("AgentSession steerIfRunning", () => {
	const harnesses: Harness[] = [];
	const requests: string[][] = [];

	afterEach(() => {
		requests.length = 0;
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	const reply =
		(text: string): FauxResponseFactory =>
		(context) => {
			requests.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
			return fauxAssistantMessage(text);
		};

	it("does not queue anything while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([reply("ok")]);

		expect(await harness.session.steerIfRunning("late correction")).toBe("idle");
		expect(harness.session.pendingMessageCount).toBe(0);
		await harness.session.prompt("new task");

		expect(requests).toEqual([["new task"]]);
	});

	it("delivers into the active run before the next request", async () => {
		const wait = waitTool();
		const harness = await createHarness({ tools: [wait.tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }), reply("done")]);

		const run = harness.session.prompt("start");
		await wait.started;
		expect(await harness.session.steerIfRunning("use the other API")).toBe("queued");
		wait.release();
		await run;

		expect(requests).toEqual([["start", "use the other API"]]);
	});

	it("drops steering an aborted run did not deliver instead of sending it with the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const requestStarted = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				requestStarted.resolve();
				await new Promise((resolve) => setTimeout(resolve, 50));
				return fauxAssistantMessage("interrupted");
			},
			reply("next"),
		]);

		const run = harness.session.prompt("start");
		await requestStarted.promise;
		expect(await harness.session.steerIfRunning("too late")).toBe("queued");
		await Promise.all([run, harness.session.abort()]);
		expect(harness.session.pendingMessageCount).toBe(0);
		await harness.session.prompt("new task");

		expect(requests.at(-1)).not.toContain("too late");
		expect(requests.at(-1)).toContain("new task");
	});

	it("reports expired when the run ends while input handlers run", async () => {
		const handlerStarted = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "slow correction") return;
						handlerStarted.resolve();
						await releaseHandler.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const firstRequest = Promise.withResolvers<void>();
		const finishFirst = Promise.withResolvers<void>();
		harness.setResponses([
			async (...args) => {
				firstRequest.resolve();
				await finishFirst.promise;
				return reply("first")(...args);
			},
			reply("second"),
		]);

		const run = harness.session.prompt("first task");
		await firstRequest.promise;
		const steer = harness.session.steerIfRunning("slow correction");
		await handlerStarted.promise;
		finishFirst.resolve();
		await run;
		releaseHandler.resolve();

		expect(await steer).toBe("expired");
		await harness.session.prompt("second task");
		expect(requests).toEqual([["first task"], ["first task", "second task"]]);
	});

	it("joins the run while before_agent_start handlers run", async () => {
		const handlerStarted = Promise.withResolvers<void>();
		const releaseHandler = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						handlerStarted.resolve();
						await releaseHandler.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([reply("done")]);

		const run = harness.session.prompt("start");
		await handlerStarted.promise;
		expect(await harness.session.steerIfRunning("before the first request")).toBe("queued");
		releaseHandler.resolve();
		await run;

		expect(requests).toEqual([["start", "before the first request"]]);
	});
});
