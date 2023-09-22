import {
  Factories,
  HubError,
  getInsecureHubRpcClient,
  HubRpcClient,
  FarcasterNetwork,
  Message,
  CastId,
  OnChainEvent,
} from "@farcaster/hub-nodejs";
import { err } from "neverthrow";
import SyncEngine from "../../network/sync/syncEngine.js";

import Server from "../server.js";
import { jestRocksDB } from "../../storage/db/jestUtils.js";
import Engine from "../../storage/engine/index.js";
import { MockHub } from "../../test/mocks.js";

const db = jestRocksDB("protobufs.rpc.submitService.test");
const network = FarcasterNetwork.TESTNET;
const engine = new Engine(db, network);
const hub = new MockHub(db, engine);

let syncEngine: SyncEngine;
let server: Server;
let client: HubRpcClient;

beforeAll(async () => {
  syncEngine = new SyncEngine(hub, db);
  server = new Server(hub, engine, syncEngine);
  const port = await server.start();
  client = getInsecureHubRpcClient(`127.0.0.1:${port}`);
});

afterAll(async () => {
  client.close();
  await syncEngine.stop();
  await server.stop();
  await engine.stop();
});

const fid = Factories.Fid.build();
const signer = Factories.Ed25519Signer.build();
const custodySigner = Factories.Eip712Signer.build();

let custodyEvent: OnChainEvent;
let signerEvent: OnChainEvent;
let storageEvent: OnChainEvent;
let castAdd: Message;
let castRemove: Message;

beforeAll(async () => {
  const signerKey = (await signer.getSignerKey())._unsafeUnwrap();
  const custodySignerKey = (await custodySigner.getSignerKey())._unsafeUnwrap();
  custodyEvent = Factories.IdRegistryOnChainEvent.build({ fid }, { transient: { to: custodySignerKey } });
  signerEvent = Factories.SignerOnChainEvent.build({ fid }, { transient: { signer: signerKey } });
  storageEvent = Factories.StorageRentOnChainEvent.build({ fid });

  castAdd = await Factories.CastAddMessage.create({ data: { fid, network } }, { transient: { signer } });

  castRemove = await Factories.CastRemoveMessage.create(
    { data: { fid, network, castRemoveBody: { targetHash: castAdd.hash } } },
    { transient: { signer } },
  );
});

describe("submitMessage", () => {
  describe("with signer", () => {
    beforeEach(async () => {
      await engine.mergeOnChainEvent(custodyEvent);
      await engine.mergeOnChainEvent(signerEvent);
      await engine.mergeOnChainEvent(storageEvent);
    });

    test("succeeds", async () => {
      const result = await client.submitMessage(castAdd);
      expect(Message.toJSON(result._unsafeUnwrap())).toEqual(Message.toJSON(castAdd));
      const getCast = await client.getCast(CastId.create({ fid: castAdd.data?.fid ?? 0, hash: castAdd.hash }));
      expect(Message.toJSON(getCast._unsafeUnwrap())).toEqual(Message.toJSON(castAdd));
    });

    test("fails with conflict", async () => {
      await engine.mergeMessage(castRemove);
      const result = await client.submitMessage(castAdd);
      expect(result).toEqual(err(new HubError("bad_request.conflict", "message conflicts with a CastRemove")));
    });
  });

  test("fails without signer", async () => {
    const result = await client.submitMessage(castAdd);
    const err = result._unsafeUnwrapErr();
    expect(err.errCode).toEqual("bad_request.validation_failure");
    expect(err.message).toMatch("unknown fid");
  });
});
