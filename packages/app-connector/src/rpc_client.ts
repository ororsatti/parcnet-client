import {
  ParcnetEvents,
  ParcnetGPCRPC,
  ParcnetIdentityRPC,
  ParcnetPODRPC,
  ParcnetRPC,
  ParcnetRPCMethodName,
  ParcnetRPCSchema,
  PODQuery,
  ProveResult,
  RPCMessage,
  RPCMessageSchema,
  RPCMessageType,
  SubscriptionUpdateResult
} from "@parcnet/client-rpc";
import { PodspecProofRequest } from "@parcnet/podspec";
import { GPCProof, GPCRevealedClaims } from "@pcd/gpc";
import { EventEmitter } from "eventemitter3";
import { z, ZodFunction, ZodTuple, ZodTypeAny } from "zod";
import { DialogController } from "./adapters/iframe.js";

/**
 * The RPC connector handles low-level communication with the client.
 * It is responsible for sending and receiving messages via MessagePorts,
 * as well as for parsing the responses.
 */
export class ParcnetRPCConnector implements ParcnetRPC, ParcnetEvents {
  public pod: ParcnetPODRPC;
  public gpc: ParcnetGPCRPC;
  public identity: ParcnetIdentityRPC;
  public _version = "1" as const;

  // #-prefix indicates private fields, enforced at the JavaScript level so
  // that these values are not accessible outside of the class.
  #dialogController: DialogController;
  // The MessagePort to send/receive messages over.
  // In cases where we're communicating with an iframe, the port will be
  // created inside that iframe. In cases where we're communicating with a
  // websocket, the websocket adapter will create a port and bridge the
  // websocket over the port. This means that this class only needs to know
  // about MessagePorts.
  #port: MessagePort;
  // Each request has a unique ID, which is just an incrementing number.
  #serial = 0;
  // Pending invocations, keyed by their serial ID.
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();
  #emitter: EventEmitter;
  #connected = false;

  /**
   * Invoke a method on the remote client.
   * The returned promise will be resolved when we get a response from the
   * client, with either a result or an error.
   *
   * @param fn - The method name.
   * @param args - The arguments to pass to the method.
   * @returns A promise that resolves to the method's return value.
   */
  #invoke(fn: string, args: unknown[]): Promise<unknown> {
    if (!this.#connected) {
      throw new Error("Client is not connected");
    }
    this.#serial++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(this.#serial, { resolve, reject });
      this.#port.postMessage({
        type: RPCMessageType.PARCNET_CLIENT_INVOKE,
        fn,
        args,
        serial: this.#serial
      });
    });
    return promise;
  }

  /**
   * Provides type-safe invocation, ensuring that we pass the correct types in
   * and that we parse the result to ensure that it is of the correct type.
   *
   * @param fn - The method name.
   * @param args - The arguments to pass to the method.
   * @returns A promise that resolves to the method's return value.
   */
  async #typedInvoke<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    A extends ZodTuple<any, any>,
    R extends ZodTypeAny,
    F extends ZodFunction<A, R>
  >(
    fn: ParcnetRPCMethodName,
    args: z.infer<ReturnType<F["parameters"]>>,
    functionSchema: F
  ): Promise<z.infer<ReturnType<F["returnType"]>>> {
    const result = this.#invoke(fn, args);
    // Ensure that the result is of the expected type
    const parsedResult = functionSchema.returnType().safeParse(result);
    if (parsedResult.success) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await parsedResult.data;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return result;
    } else {
      throw new Error(
        `Failed to parse result for ${fn}: ${parsedResult.error.message}`
      );
    }
  }

  constructor(port: MessagePort, dialogController: DialogController) {
    this.#port = port;
    this.#dialogController = dialogController;
    this.#emitter = new EventEmitter();

    this.pod = {
      query: async (query: PODQuery): Promise<string[]> => {
        return this.#typedInvoke(
          "pod.query",
          [query],
          ParcnetRPCSchema.shape.pod.shape.query
        );
      },
      insert: async (serializedPod: string): Promise<void> => {
        return this.#typedInvoke(
          "pod.insert",
          [serializedPod],
          ParcnetRPCSchema.shape.pod.shape.insert
        );
      },
      delete: async (serializedPod: string): Promise<void> => {
        return this.#typedInvoke(
          "pod.delete",
          [serializedPod],
          ParcnetRPCSchema.shape.pod.shape.delete
        );
      },
      subscribe: async (query: PODQuery): Promise<string> => {
        return this.#typedInvoke(
          "pod.subscribe",
          [query],
          ParcnetRPCSchema.shape.pod.shape.subscribe
        );
      },
      unsubscribe: async (subscriptionId: string): Promise<void> => {
        return this.#typedInvoke(
          "pod.unsubscribe",
          [subscriptionId],
          ParcnetRPCSchema.shape.pod.shape.unsubscribe
        );
      }
    };
    this.gpc = {
      prove: async (request: PodspecProofRequest): Promise<ProveResult> => {
        return this.#typedInvoke(
          "gpc.prove",
          [request],
          ParcnetRPCSchema.shape.gpc.shape.prove
        );
      },
      canProve: async (request: PodspecProofRequest): Promise<boolean> => {
        return this.#typedInvoke(
          "gpc.canProve",
          [request],
          ParcnetRPCSchema.shape.gpc.shape.canProve
        );
      },
      verify: async (
        proof: GPCProof,
        revealedClaims: GPCRevealedClaims,
        proofRequest: PodspecProofRequest
      ): Promise<boolean> => {
        return this.#typedInvoke(
          "gpc.verify",
          [proof, revealedClaims, proofRequest],
          ParcnetRPCSchema.shape.gpc.shape.verify
        );
      }
    };
    this.identity = {
      getSemaphoreV3Commitment: async (): Promise<bigint> => {
        return this.#typedInvoke(
          "identity.getSemaphoreV3Commitment",
          [],
          ParcnetRPCSchema.shape.identity.shape.getSemaphoreV3Commitment
        );
      }
    };
  }

  /**
   * Start the RPC client.
   *
   * This starts an event loop which waits indefinitely for messages from
   * the client.
   *
   * @param onConnect - Callback to call when the client is ready.
   */
  public start(onConnect: () => void): void {
    const eventLoop = this.main(onConnect);
    eventLoop.next();

    // Set up a listener for messages from the client
    // Messages are sent to the event loop for processing
    this.#port.addEventListener("message", (ev: MessageEvent) => {
      const msg = RPCMessageSchema.safeParse(ev.data);
      if (msg.success) {
        eventLoop.next(msg.data);
      } else {
        console.error("Invalid message received: ", ev);
      }
    });
    this.#port.start();
  }

  /**
   * Main event loop for the client.
   *
   * This is a generator function, which means that it yields control to the
   * caller whenever it needs to wait for an event. Events are inserted into
   * the event loop by the message port listener set up in `start()`.
   *
   * @param onConnect - Callback to call when the client is ready.
   */
  private *main(onConnect: () => void): Generator<undefined, void, RPCMessage> {
    // Loop indefinitely until we get a PARCNET_CLIENT_READY message
    // In the meantime, we will handle PARCNET_CLIENT_SHOW and
    // PARCNET_CLIENT_HIDE, as these may be necessary for the client to allow
    // the user to log in, which is a prerequisite for using the rest of the API
    // and for the PARCNET_CLIENT_READY message to be sent.
    while (true) {
      const event = yield;
      console.log(`RECEIVED ${event.type}`);
      if (event.type === RPCMessageType.PARCNET_CLIENT_READY) {
        this.#connected = true;
        onConnect();
        break;
      } else if (event.type === RPCMessageType.PARCNET_CLIENT_SHOW) {
        this.#dialogController.show();
      } else if (event.type === RPCMessageType.PARCNET_CLIENT_HIDE) {
        this.#dialogController.close();
      }
    }

    while (true) {
      const event = yield;
      console.log(`RECEIVED ${event.type}`);
      if (event.type === RPCMessageType.PARCNET_CLIENT_INVOKE_RESULT) {
        this.#pending.get(event.serial)?.resolve(event.result);
      } else if (event.type === RPCMessageType.PARCNET_CLIENT_INVOKE_ERROR) {
        this.#pending.get(event.serial)?.reject(new Error(event.error));
      } else if (event.type === RPCMessageType.PARCNET_CLIENT_SHOW) {
        this.#dialogController.show();
      } else if (event.type === RPCMessageType.PARCNET_CLIENT_HIDE) {
        this.#dialogController.close();
      } else if (
        event.type === RPCMessageType.PARCNET_CLIENT_SUBSCRIPTION_UPDATE
      ) {
        this.#emitSubscriptionUpdate(event.update, event.subscriptionId);
      }
    }
  }

  on(
    event: "subscription-update",
    callback: (result: SubscriptionUpdateResult) => void
  ): void {
    this.#emitter.on("subscription-update", callback);
  }

  off(
    event: "subscription-update",
    callback: (result: SubscriptionUpdateResult) => void
  ): void {
    this.#emitter.off("subscription-update", callback);
  }

  removeAllListeners(): void {
    this.#emitter.removeAllListeners("subscription-update");
  }

  #emitSubscriptionUpdate(update: string[], subscriptionId: string): void {
    this.#emitter.emit("subscription-update", { update, subscriptionId });
  }

  public isConnected(): boolean {
    return this.#connected;
  }
}
