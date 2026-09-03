/** Remix/Pudding snake color palette — ids match #color after SnakeColor. */
(function (root) {
  const DEFAULT_RAINBOW = [
    "#4E7CF6",
    "#5499C7",
    "#AF7AC5",
    "#E74C3C",
    "#F39C12",
    "#CCC31C",
    "#27AE60",
  ];

  const solids = [
    { id: 0, name: "Blue", kind: "solid", primary: "#4E7CF6", secondary: "#17439F" },
    { id: 1, name: "Cyan", kind: "solid", primary: "#19D8E6", secondary: "#15B5C1" },
    { id: 2, name: "Purple", kind: "solid", primary: "#B648F2", secondary: "#910FD7" },
    { id: 3, name: "Pink", kind: "solid", primary: "#ED44B5", secondary: "#C31388" },
    { id: 4, name: "Red", kind: "solid", primary: "#F53D40", secondary: "#D00B0E" },
    { id: 5, name: "Orange", kind: "solid", primary: "#F69C3C", secondary: "#EA7E0B" },
    { id: 6, name: "Yellow", kind: "solid", primary: "#ECD613", secondary: "#D9C512" },
    { id: 7, name: "Green", kind: "solid", primary: "#35B63E", secondary: "#298E30" },
    { id: 8, name: "Gray", kind: "solid", primary: "#6B6B6B", secondary: "#404040" },
    { id: 9, name: "White", kind: "solid", primary: "#F2F2F2", secondary: "#D9D9D9" },
    { id: 11, name: "Blue Red", kind: "solid", primary: "#3888F8", secondary: "#E4425E" },
    { id: 12, name: "Purple Orange", kind: "solid", primary: "#B749EC", secondary: "#EF8826" },
    { id: 13, name: "Pink Yellow", kind: "solid", primary: "#F53AA2", secondary: "#F5D40E" },
    { id: 14, name: "Yellow Green", kind: "solid", primary: "#F9B202", secondary: "#4CBD1E" },
    { id: 15, name: "Green Blue", kind: "solid", primary: "#39C14C", secondary: "#3A79F2" },
    { id: 16, name: "Gray White", kind: "solid", primary: "#6B6B6B", secondary: "#F2F2F2" },
    { id: 17, name: "White Gray", kind: "solid", primary: "#F2F2F2", secondary: "#6B6B6B" },
    { id: 18, name: "Black", kind: "solid", primary: "#222222", secondary: "#000000" },
    { id: 19, name: "Neon Red", kind: "solid", primary: "#FF0000", secondary: "#FF0000" },
    { id: 20, name: "Neon Blue", kind: "solid", primary: "#0000FF", secondary: "#0000FF" },
    { id: 21, name: "Neon Green", kind: "solid", primary: "#00FF00", secondary: "#00FF00" },
    { id: 22, name: "White Black", kind: "solid", primary: "#FFFFFF", secondary: "#000000" },
    { id: 23, name: "Black White", kind: "solid", primary: "#222222", secondary: "#FFFFFF" },
    { id: 24, name: "Nep Purple", kind: "solid", primary: "#6759B9", secondary: "#5B50B0" },
    { id: 25, name: "Noire Blue", kind: "solid", primary: "#0059b9", secondary: "#0050b0" },
    { id: 26, name: "Pitch Black", kind: "solid", primary: "#000000", secondary: "#000000" },
    { id: 27, name: "Purple Heart", kind: "solid", primary: "#ffaaff", secondary: "#ff77ff" },
    { id: 28, name: "Brown", kind: "solid", primary: "#964B00", secondary: "#7B3F00" },
    { id: 29, name: "Extra Brown", kind: "solid", primary: "#4B2D08", secondary: "#1B1D08" },
    { id: 30, name: "Gold", kind: "solid", primary: "#b59b1d", secondary: "#947f19" },
    { id: 31, name: "Silver", kind: "solid", primary: "#87868c", secondary: "#555652" },
    { id: 32, name: "Dark Teal", kind: "solid", primary: "#667da4", secondary: "#4c5a73" },
    { id: 33, name: "Hotpink", kind: "solid", primary: "#bd2862", secondary: "#a72356" },
    { id: 34, name: "Navy Blue", kind: "solid", primary: "#000080", secondary: "#000080" },
  ];

  const rainbows = [
    { id: 10, name: "Default Rainbow", kind: "rainbow", override: 0, set: DEFAULT_RAINBOW },
    {
      id: 35,
      name: "Pride",
      kind: "rainbow",
      override: 1,
      set: ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"],
    },
    {
      id: 36,
      name: "Bisexual",
      kind: "rainbow",
      override: 2,
      set: ["#D60270", "#D60270", "#9B4F96", "#0038A8", "#0038A8"],
    },
    {
      id: 37,
      name: "Transgender",
      kind: "rainbow",
      override: 3,
      set: ["#55CDFC", "#55CDFC", "#ffffff", "#ffffff", "#F7A8B8", "#F7A8B8"],
    },
    {
      id: 38,
      name: "Pansexual",
      kind: "rainbow",
      override: 4,
      set: ["#FF1B8D", "#FF1B8D", "#FFDA00", "#FFDA00", "#1BB3FF", "#1BB3FF"],
    },
    {
      id: 39,
      name: "Asexual",
      kind: "rainbow",
      override: 5,
      set: ["#000000", "#a3a3a3", "#ffffff", "#810082"],
    },
    {
      id: 40,
      name: "Aromantic",
      kind: "rainbow",
      override: 6,
      set: ["#3AA63F", "#A8D47A", "#FFFFFF", "#AAAAAA", "#000000"],
    },
    {
      id: 41,
      name: "Intersex",
      kind: "rainbow",
      override: 7,
      set: ["#FFDA00", "#FFDA00", "#7A00AC", "#7A00AC"],
    },
    {
      id: 42,
      name: "Lesbian",
      kind: "rainbow",
      override: 8,
      set: ["#D62900", "#FF9B55", "#FFFFFF", "#D461A6", "#A50062"],
    },
    {
      id: 43,
      name: "Non-binary",
      kind: "rainbow",
      override: 9,
      set: ["#000000", "#fff433", "#ffffff", "#9b59d0"],
    },
    {
      id: 44,
      name: "Monochrome",
      kind: "rainbow",
      override: 10,
      set: ["#808080", "#9E9E9E", "#808080", "#616161"],
    },
    {
      id: 45,
      name: "Catalonia",
      kind: "rainbow",
      override: 11,
      set: ["#0f47af", "#ffffff", "#0f47af", "#ffd700", "#cc0000", "#ffd700", "#cc0000"],
    },
  ];

  const RANDOM = { id: 46, name: "Random", kind: "random" };

  const BY_ID = {};
  for (const c of solids.concat(rainbows)) BY_ID[c.id] = c;
  BY_ID[46] = RANDOM;

  const CLAIMABLE_IDS = solids.concat(rainbows).map((c) => c.id);

  function getColor(id) {
    return BY_ID[id] || null;
  }

  function colorName(id) {
    const c = getColor(id);
    return c ? c.name : "Spectator";
  }

  function isClaimable(id) {
    return id !== 46 && !!BY_ID[id] && BY_ID[id].kind !== "random";
  }

  /** Disambiguate duplicate color names in Versus: Blue, Blue 2, … */
  function displayNameFor(client, roster) {
    if (client.displayName && String(client.displayName).trim()) {
      return String(client.displayName).trim();
    }
    if (client.role === "spectator" && (client.colorId == null || client.colorId === undefined)) {
      return "Spectator";
    }
    const base = colorName(client.colorId);
    const same = roster.filter(
      (o) =>
        o.clientId !== client.clientId &&
        !(o.displayName && String(o.displayName).trim()) &&
        o.colorId === client.colorId
    );
    if (!same.length) return base;
    const ordered = roster
      .filter(
        (o) =>
          !(o.displayName && String(o.displayName).trim()) && o.colorId === client.colorId
      )
      .sort((a, b) => (a.joinOrder || 0) - (b.joinOrder || 0));
    const idx = ordered.findIndex((o) => o.clientId === client.clientId);
    return idx <= 0 ? base : base + " " + (idx + 1);
  }

  const API = {
    REGULAR_COLORS: 35,
    ALL_COLORS_LENGTH: 46,
    SNAKE_COLORS: solids.concat(rainbows).concat([RANDOM]),
    CLAIMABLE_IDS,
    DEFAULT_RAINBOW,
    getColor,
    colorName,
    isClaimable,
    displayNameFor,
  };

  root.MultiplayerColors = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
