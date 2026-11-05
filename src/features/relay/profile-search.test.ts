import { describe, expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";
import {
  createProfileSearch,
  PROFILE_SEARCH_HEADS_MS,
  PROFILE_SEARCH_QUERY_MAX,
  PROFILE_SEARCH_RETRY_MS,
  searchedProfiles,
} from "./profile-search";
import type { VerifiedProfileAuthority } from "./verified-profile";
import type { ReadOptions } from "./reader";
import { keypair, signed } from "./testing";

const profiles = Array.from({ length: 5 }, (_, index) =>
  signed(keypair(), {
    kind: 0,
    content: JSON.stringify({ name: `Wes ${index}` }),
    tags: [],
  }),
);
const nip50 = signed(keypair(), {
  kind: 0,
  content: JSON.stringify({ name: "Westie" }),
  tags: [],
});

function setup(
  search?: (
    query: string,
    limit: number,
    page: number,
  ) => Promise<RelayEvent[]>,
) {
  const reads: ReadFilter[][] = [];
  const endpoint = search
    ? vi.fn(
        (query: string, limit: number, page: number, _options?: ReadOptions) =>
          search(query, limit, page),
      )
    : undefined;
  const fallback = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      reads.push([...filters]);
      return [nip50];
    }),
    ...(endpoint ? { searchProfiles: endpoint } : {}),
  };
  const clock = { now: 1_000_000 };
  const searchProfiles = createProfileSearch(fallback, () => clock.now);
  return { searchProfiles, endpoint, fallback, reads, clock };
}

const signal = () => new AbortController().signal;

it("asks the name-only endpoint and never sends NIP-50 search", async () => {
  const { searchProfiles, endpoint, reads } = setup(async () => profiles);
  expect(
    await searchProfiles(" wes ", { limit: 40, signal: signal() }),
  ).toEqual(profiles);
  expect(endpoint).toHaveBeenCalledWith("wes", 40, 1, {
    signal: expect.any(AbortSignal),
    priority: "foreground",
    fresh: true,
  });
  expect(reads).toEqual([]);
});

it("passes the requested page to the endpoint", async () => {
  const { searchProfiles, endpoint } = setup(async (_, limit, page) =>
    profiles.slice((page - 1) * limit, page * limit),
  );
  expect(
    await searchProfiles("wes", { limit: 2, page: 2, signal: signal() }),
  ).toEqual(profiles.slice(2, 4));
  expect(endpoint).toHaveBeenLastCalledWith("wes", 2, 2, {
    signal: expect.any(AbortSignal),
    priority: "foreground",
    fresh: true,
  });
  // No total cap: a page past the first hundred results still reaches the relay.
  await searchProfiles("wes", { limit: 30, page: 5, signal: signal() });
  expect(endpoint).toHaveBeenLastCalledWith("wes", 30, 5, {
    signal: expect.any(AbortSignal),
    priority: "foreground",
    fresh: true,
  });
});

it.each([404, 405])(
  "uses NIP-50 search for a while on a relay that answers %i, then retries",
  async (status) => {
    let missing = true;
    const { searchProfiles, endpoint, reads, clock } = setup(async () => {
      if (missing) throw new ReadError("unavailable", "missing", status);
      return profiles;
    });
    expect(
      await searchProfiles("wes", { limit: 30, page: 2, signal: signal() }),
    ).toEqual([nip50]);
    clock.now += PROFILE_SEARCH_RETRY_MS - 1;
    expect(await searchProfiles("we", { limit: 40, signal: signal() })).toEqual(
      [nip50],
    );
    expect(endpoint).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([
      [
        {
          kinds: [0],
          search: "wes",
          search_mode: "prefix",
          limit: 30,
          page: 2,
        },
      ],
      [{ kinds: [0], search: "we", search_mode: "prefix", limit: 40 }],
    ]);
    // The relay was upgraded meanwhile: the next search after the wait uses it.
    missing = false;
    clock.now += 1;
    expect(
      await searchProfiles("wes", { limit: 40, signal: signal() }),
    ).toEqual(profiles);
    expect(endpoint).toHaveBeenCalledTimes(2);
    expect(reads).toHaveLength(2);
  },
);

it("reports other endpoint failures instead of hiding them behind NIP-50", async () => {
  for (const status of [401, 429, 500]) {
    const { searchProfiles, reads } = setup(async () => {
      throw new ReadError("unavailable", "failed", status);
    });
    await expect(
      searchProfiles("wes", { limit: 40, signal: signal() }),
    ).rejects.toMatchObject({ status });
    expect(reads).toEqual([]);
  }
});

it("falls back when a relay that served the endpoint loses it", async () => {
  let missing = false;
  const { searchProfiles, reads } = setup(async () => {
    if (missing) throw new ReadError("unavailable", "missing", 404);
    return profiles;
  });
  await searchProfiles("wes", { limit: 40, signal: signal() });
  missing = true;
  expect(await searchProfiles("wes", { limit: 40, signal: signal() })).toEqual([
    nip50,
  ]);
  expect(reads).toEqual([
    [{ kinds: [0], search: "wes", search_mode: "prefix", limit: 40 }],
  ]);
});

it("sends a query over the relay's character limit to NIP-50 search", async () => {
  const { searchProfiles, endpoint, reads } = setup(async () => profiles);
  // Code points, not UTF-16 units: 100 emoji are 200 units and still fit.
  const longest = "😀".repeat(PROFILE_SEARCH_QUERY_MAX);
  await searchProfiles(` ${longest} `, { limit: 40, signal: signal() });
  expect(endpoint).toHaveBeenCalledTimes(1);
  expect(endpoint).toHaveBeenLastCalledWith(longest, 40, 1, expect.anything());
  const over = "w".repeat(PROFILE_SEARCH_QUERY_MAX + 1);
  expect(await searchProfiles(over, { limit: 40, signal: signal() })).toEqual([
    nip50,
  ]);
  expect(endpoint).toHaveBeenCalledTimes(1);
  expect(reads).toEqual([
    [{ kinds: [0], search: over, search_mode: "prefix", limit: 40 }],
  ]);
  // Not a missing endpoint: the next short query uses it right away.
  await searchProfiles("wes", { limit: 40, signal: signal() });
  expect(endpoint).toHaveBeenCalledTimes(2);
});

it("keeps non-profile events out of the result", async () => {
  const message = signed(keypair(), { kind: 9, content: "wes", tags: [] });
  const { searchProfiles } = setup(async () => [message, ...profiles]);
  expect(await searchProfiles("wes", { limit: 40, signal: signal() })).toEqual(
    profiles,
  );
});

it("uses NIP-50 search when the transport has no endpoint", async () => {
  const { searchProfiles, reads } = setup();
  expect(await searchProfiles("wes", { limit: 15, signal: signal() })).toEqual([
    nip50,
  ]);
  expect(reads).toEqual([
    [{ kinds: [0], search: "wes", search_mode: "prefix", limit: 15 }],
  ]);
});

describe("verified heads from a searchable relay", () => {
  const relay = keypair(),
    stranger = keypair(),
    fake = keypair(),
    plain = keypair();
  // Transports admit signed events; the relay key decides, not the signature.
  const head = (author: ReturnType<typeof keypair>, created_at: number) =>
    eventDto(
      signed(author, {
        kind: 30382,
        created_at,
        content: "",
        tags: [["d", fake.pubkey]],
      }),
    );
  const fakeProfile = signed(fake, {
    kind: 0,
    content: JSON.stringify({ name: "Fak" }),
    tags: [],
  });
  const plainProfile = signed(plain, {
    kind: 0,
    content: JSON.stringify({ name: "Plain" }),
    tags: [],
  });
  const older = head(relay, 1_000);
  const newest = head(relay, 2_000);
  const response = [
    fakeProfile,
    older,
    newest,
    head(stranger, 3_000),
    plainProfile,
  ];
  function headsSetup(
    authority: VerifiedProfileAuthority | undefined,
    events: RelayEvent[] = response,
  ) {
    const clock = { now: 1_000_000 };
    const current = { authority };
    const searchProfiles = createProfileSearch(
      { read: vi.fn(async () => [nip50]), searchProfiles: async () => events },
      () => clock.now,
      () => current.authority,
    );
    return { searchProfiles, clock, current };
  }
  const searchable: VerifiedProfileAuthority = {
    pubkey: relay.pubkey,
    multipleIssuers: false,
    searchable: true,
  };

  it("keeps each found person\x27s newest relay head, or none, once", async () => {
    const t = headsSetup(searchable);
    // Each person's profile and newest relay head; others are dropped.
    expect(
      await t.searchProfiles("fak", { limit: 30, signal: signal() }),
    ).toEqual([fakeProfile, newest, plainProfile]);
    const pubkeys = [fake.pubkey, plain.pubkey, keypair().pubkey];
    expect(t.searchProfiles.verifiedHeads(pubkeys, searchable)).toEqual(
      new Map([
        [fake.pubkey, newest],
        [plain.pubkey, undefined],
      ]),
    );
    // A taken answer is not given again; the next look reads.
    expect(t.searchProfiles.verifiedHeads(pubkeys, searchable).size).toBe(0);
  });

  it("keeps nothing unless the authority is searchable", async () => {
    const t = headsSetup({ pubkey: relay.pubkey, multipleIssuers: false });
    await t.searchProfiles("fak", { limit: 30, signal: signal() });
    const current = t.current.authority as VerifiedProfileAuthority;
    expect(t.searchProfiles.verifiedHeads([fake.pubkey], current).size).toBe(0);
  });

  it("answers only the same authority, and only while recent", async () => {
    const t = headsSetup(searchable);
    await t.searchProfiles("fak", { limit: 30, signal: signal() });
    expect(
      t.searchProfiles.verifiedHeads([fake.pubkey], { ...searchable }).size,
    ).toBe(0);
    await t.searchProfiles("fak", { limit: 30, signal: signal() });
    t.clock.now += PROFILE_SEARCH_HEADS_MS - 1;
    expect(t.searchProfiles.verifiedHeads([fake.pubkey], searchable).size).toBe(
      1,
    );
    await t.searchProfiles("fak", { limit: 30, signal: signal() });
    t.clock.now += PROFILE_SEARCH_HEADS_MS;
    expect(t.searchProfiles.verifiedHeads([fake.pubkey], searchable).size).toBe(
      0,
    );
  });
});

describe("people found only by a verified name", () => {
  const relay = keypair(),
    stranger = keypair(),
    unprofiled = keypair(),
    plain = keypair();
  const authority: VerifiedProfileAuthority = {
    pubkey: relay.pubkey,
    multipleIssuers: false,
    searchable: true,
  };
  const head = (
    author: ReturnType<typeof keypair>,
    display: string,
    created_at = 1_000,
  ) =>
    eventDto(
      signed(author, {
        kind: 30382,
        created_at,
        content: "",
        tags: [
          ["d", unprofiled.pubkey],
          ["p", unprofiled.pubkey],
          ["active", "true"],
          ["display_name", display],
          ["username", "brittneyg"],
          ["issuer_label", "Example"],
          ["verified_at", "1"],
        ],
      }),
    );
  const older = head(relay, "brittney old", 500);
  const current = head(relay, "Brittney G");
  // A newer head for the same person from any other key is forged.
  const forged = head(stranger, "Mallory", 2_000);
  const plainProfile = signed(plain, {
    kind: 0,
    content: JSON.stringify({ name: "Brittany Plain" }),
    tags: [],
  });
  function search(authorityNow: VerifiedProfileAuthority | undefined) {
    return createProfileSearch(
      {
        read: vi.fn(async () => [nip50]),
        searchProfiles: async () => [older, forged, current, plainProfile],
      },
      () => 1_000_000,
      () => authorityNow,
    );
  }

  it("returns each person\x27s profile and newest relay head", async () => {
    expect(
      await search(authority)("brit", { limit: 30, signal: signal() }),
    ).toEqual([current, plainProfile]);
    // Without an authority no head is trusted.
    expect(
      await search(undefined)("brit", { limit: 30, signal: signal() }),
    ).toEqual([plainProfile]);
  });

  it("names a person with no profile by their relay-signed head only", () => {
    const found = searchedProfiles([forged, current, plainProfile], authority);
    expect([...found.keys()]).toEqual([unprofiled.pubkey, plain.pubkey]);
    expect(found.get(unprofiled.pubkey)).toMatchObject({
      name: "Brittney G",
      username: "brittneyg",
      verified: { displayName: "Brittney G", username: "brittneyg" },
    });
    // A forged head alone names no one, nor does a copy whose signature was
    // never checked, nor a head under another authority.
    expect(searchedProfiles([forged], authority).size).toBe(0);
    expect(searchedProfiles([{ ...current }], authority).size).toBe(0);
    expect(
      searchedProfiles([current], {
        pubkey: stranger.pubkey,
        multipleIssuers: false,
      }).size,
    ).toBe(0);
  });

  it("keeps a person\x27s own profile, with the verified name it was found by", () => {
    const own = signed(unprofiled, {
      kind: 0,
      content: JSON.stringify({ name: "Brit" }),
      tags: [],
    });
    expect(
      searchedProfiles([current, own], authority).get(unprofiled.pubkey),
    ).toMatchObject({ name: "Brit", verified: { displayName: "Brittney G" } });
  });

  it("drops a verified name a newer malformed head withdrew", () => {
    const withdrawn = eventDto(
      signed(relay, {
        kind: 30382,
        created_at: 3_000,
        content: "",
        tags: [
          ["d", unprofiled.pubkey],
          ["p", unprofiled.pubkey],
        ],
      }),
    );
    expect(searchedProfiles([current, withdrawn], authority).size).toBe(0);
    const own = signed(unprofiled, {
      kind: 0,
      content: JSON.stringify({ name: "Brit" }),
      tags: [],
    });
    const found = searchedProfiles([current, own, withdrawn], authority);
    expect(found.get(unprofiled.pubkey)).toEqual(
      expect.not.objectContaining({ verified: expect.anything() }),
    );
    expect(found.get(unprofiled.pubkey)?.name).toBe("Brit");
  });
});
