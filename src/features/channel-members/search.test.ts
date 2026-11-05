import { expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { createRelaySession, type RelaySession } from "../relay/session";
import { keypair, profile, signed } from "../relay/testing";
import { eventDto, type ReadFilter } from "../relay/events";
import { searchMembers, MEMBER_SEARCH_PAGE_SIZE } from "./search";

it("uses the server prefix-search page, distinguishes namesakes, ranks exact names, and reports another page", async () => {
  const viewer = keypair(),
    relay = keypair();
  const rows = Array.from({ length: MEMBER_SEARCH_PAGE_SIZE }, (_, i) =>
    profile(keypair(), { name: i === 2 ? "Morgan" : "Morgan Martin" }),
  );
  const query = vi.fn(async (_filters: readonly ReadFilter[]) => rows);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
  });
  try {
    const result = await searchMembers(
      owner.session,
      "Morgan",
      2,
      new AbortController().signal,
    );
    expect(query.mock.calls[0]?.[0]).toEqual([
      {
        kinds: [0],
        search: "Morgan",
        search_mode: "prefix",
        page: 2,
        limit: MEMBER_SEARCH_PAGE_SIZE,
      },
    ]);
    expect(result.people).toHaveLength(MEMBER_SEARCH_PAGE_SIZE);
    expect(result.people[0]?.name).toBe("Morgan");
    expect(result.more).toBe(true);
  } finally {
    owner.dispose();
  }
});
it("resolves an exact npub without searching its display text", async () => {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const query = vi.fn(async (_filters: readonly ReadFilter[]) => [
    profile(person, { name: "Morgan" }),
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
  });
  try {
    const result = await searchMembers(
      owner.session,
      nip19.npubEncode(person.pubkey),
      1,
      new AbortController().signal,
    );
    expect(query.mock.calls[0]?.[0]).toEqual([
      { kinds: [0], authors: [person.pubkey], limit: MEMBER_SEARCH_PAGE_SIZE },
    ]);
    expect(result.people[0]?.pubkey).toBe(person.pubkey);
    expect(result.more).toBe(false);
  } finally {
    owner.dispose();
  }
});
it("propagates a failed search instead of displaying no matches", async () => {
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => {
      throw new Error("Offline");
    },
  });
  try {
    await expect(
      searchMembers(owner.session, "Morgan", 1, new AbortController().signal),
    ).rejects.toThrow("Offline");
  } finally {
    owner.dispose();
  }
});

// A relay-signed directory name for someone who never saved a profile.
const verifiedHead = (author: ReturnType<typeof keypair>, subject: string) =>
  eventDto(
    signed(author, {
      kind: 30382,
      content: "",
      tags: [
        ["d", subject],
        ["p", subject],
        ["active", "true"],
        ["display_name", "brittneyg"],
        ["username", "brittneyg"],
        ["issuer_label", "Example"],
        ["verified_at", "1"],
      ],
    }),
  );
it("finds a person with no profile by their relay-signed name, never a forged one", async () => {
  const viewer = keypair(),
    relay = keypair(),
    stranger = keypair(),
    brittney = keypair(),
    impostor = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async () => [],
    searchProfiles: async () => [
      verifiedHead(relay, brittney.pubkey),
      verifiedHead(stranger, impostor.pubkey),
    ],
    verifiedProfiles: {
      pubkey: relay.pubkey,
      multipleIssuers: false,
      searchable: true,
    },
  });
  try {
    const result = await searchMembers(
      owner.session,
      "brittneyg",
      1,
      new AbortController().signal,
    );
    expect(result.people).toEqual([
      expect.objectContaining({ pubkey: brittney.pubkey, name: "brittneyg" }),
    ]);
  } finally {
    owner.dispose();
  }
});
it("resolves the npub of a person with no profile by their relay-signed name", async () => {
  const viewer = keypair(),
    relay = keypair(),
    brittney = keypair();
  const query = vi.fn(async (_filters: readonly ReadFilter[]) => [
    verifiedHead(relay, brittney.pubkey),
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
  });
  try {
    const result = await searchMembers(
      owner.session,
      nip19.npubEncode(brittney.pubkey),
      1,
      new AbortController().signal,
    );
    expect(query.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({
        kinds: [30382],
        authors: [relay.pubkey],
        "#d": [brittney.pubkey],
      }),
    );
    expect(result.people).toEqual([
      expect.objectContaining({ pubkey: brittney.pubkey, name: "brittneyg" }),
    ]);
  } finally {
    owner.dispose();
  }
});
it.each([
  ["withdrawn", () => undefined],
  ["rotated", () => ({ pubkey: keypair().pubkey, multipleIssuers: false })],
])(
  "names no one by a head when the authority is %s during an npub lookup",
  async (_change, next) => {
    const relay = keypair(),
      brittney = keypair();
    let authority: { pubkey: string; multipleIssuers: boolean } | undefined = {
      pubkey: relay.pubkey,
      multipleIssuers: false,
    };
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const session = {
      profiles: { verifiedAuthority: () => authority },
      async read() {
        await held;
        return [verifiedHead(relay, brittney.pubkey)];
      },
    } as unknown as RelaySession;
    const pending = searchMembers(
      session,
      nip19.npubEncode(brittney.pubkey),
      1,
      new AbortController().signal,
    );
    authority = next();
    release();
    expect((await pending).people).toEqual([]);
  },
);
