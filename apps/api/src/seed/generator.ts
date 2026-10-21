// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic generated people (group fillers, waiting-list applicants,
// the load scenario): a seeded pseudo-random sequence and name lists, and IDs
// from a counter, so two runs produce the same data. Fictional names only;
// no emails, phone numbers or personal identity numbers.

const NAMES = {
  SE: {
    female: [
      "Ebba",
      "Wilma",
      "Alice",
      "Freja",
      "Saga",
      "Ella",
      "Selma",
      "Agnes",
      "Stella",
      "Ines",
      "Tyra",
      "Vera",
      "Lova",
      "Klara",
      "Hedda",
      "Ida",
      "Linnea",
      "Moa",
    ],
    male: [
      "Hugo",
      "Elias",
      "William",
      "Noah",
      "Lucas",
      "Adam",
      "Theo",
      "Albin",
      "Melvin",
      "Isak",
      "Leo",
      "Axel",
      "Arvid",
      "Ludvig",
      "Viggo",
      "Malte",
      "Emil",
      "Sixten",
    ],
    family: [
      "Andersson",
      "Karlsson",
      "Persson",
      "Eriksson",
      "Larsson",
      "Olsson",
      "Gustafsson",
      "Pettersson",
      "Jonsson",
      "Lindberg",
      "Holm",
      "Sandberg",
      "Forsberg",
      "Lundgren",
      "Berglund",
      "Engström",
      "Hedlund",
      "Sjöberg",
    ],
  },
  NO: {
    female: [
      "Nora",
      "Emma",
      "Sofie",
      "Olivia",
      "Ella",
      "Maja",
      "Ingrid",
      "Sara",
      "Leah",
      "Frida",
      "Hedda",
      "Tiril",
      "Mathilde",
      "Astrid",
    ],
    male: [
      "Jakob",
      "Emil",
      "Noah",
      "Oliver",
      "Filip",
      "Aksel",
      "Henrik",
      "Magnus",
      "Sander",
      "Tobias",
      "Johannes",
      "Mathias",
      "Ola",
      "Even",
    ],
    family: [
      "Hansen",
      "Johansen",
      "Olsen",
      "Larsen",
      "Andersen",
      "Pedersen",
      "Nilsen",
      "Kristiansen",
      "Jensen",
      "Karlsen",
      "Berg",
      "Haugland",
      "Solberg",
      "Bakke",
    ],
  },
} as const;

/** Mulberry32: small, fast, good enough for test data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface GeneratedPerson {
  id: string;
  givenName: string;
  familyName: string;
  gender: "female" | "male";
}

export class Generator {
  private readonly random: () => number;
  private counter = 0;
  private readonly prefix: string;

  /** `namespace` (0–4095) keeps the IDs of different scenarios apart. */
  constructor(seed: number, namespace = 0x100) {
    this.random = mulberry32(seed);
    this.prefix = `0199a000-0000-7000-8${namespace.toString(16).padStart(3, "0")}`;
  }

  /** The next deterministic UUID (version 7 layout, fixed timestamp). */
  nextId(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter.toString(16).padStart(12, "0")}`;
  }

  int(from: number, to: number): number {
    return from + Math.floor(this.random() * (to - from + 1));
  }

  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.random() * values.length)]!;
  }

  /** A person of the gender (one of female and male at random for null or "other"). */
  person(country: string, gender: string | null = null): GeneratedPerson {
    const names = country === "NO" ? NAMES.NO : NAMES.SE;
    const g =
      gender === "female" || gender === "male" ? gender : this.random() < 0.5 ? "female" : "male";
    return {
      id: this.nextId(),
      givenName: this.pick(names[g]),
      familyName: this.pick(names.family),
      gender: g,
    };
  }
}
