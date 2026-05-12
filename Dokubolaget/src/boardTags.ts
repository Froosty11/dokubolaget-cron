export type Product = Record<string, unknown>;

export type BoardTagCandidate = {
  id: string;
  label: string;
  family: string;
  support: number;
  share: number;
  predicate: (product: Product) => boolean;
};

function countByStringField(products: Product[], field: string) {
  const counts = new Map<string, number>();
  for (const product of products) {
    const value = product[field];
    if (typeof value !== "string" || !value) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function topEntries(map: Map<string, number>, limit: number) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function createStringTags(params: {
  products: Product[];
  map: Map<string, number>;
  field: string;
  family: string;
  prefix: string;
  limit: number;
  minShare: number;
  maxShare: number;
}): BoardTagCandidate[] {
  const { products, map, field, family, prefix, limit, minShare, maxShare } = params;
  const total = products.length;
  return topEntries(map, limit)
    .map(([value, support]) => {
      const share = support / total;
      return {
        id: `${prefix}:${value}`,
        label: `${prefix}:${value}`,
        family,
        support,
        share,
        predicate: (product: Product) => product[field] === value,
      };
    })
    .filter((tag) => tag.share >= minShare && tag.share <= maxShare);
}

function createBucketTags(
  products: Product[],
  field: string,
  family: string,
  buckets: Array<{
    key: string;
    label: string;
    test: (value: number) => boolean;
  }>,
  minShare: number,
  maxShare: number,
): BoardTagCandidate[] {
  const total = products.length;
  return buckets
    .map((bucket) => {
      let support = 0;
      for (const product of products) {
        const value = product[field];
        if (typeof value === "number" && bucket.test(value)) {
          support += 1;
        }
      }
      const share = support / total;
      return {
        id: `${family}:${bucket.key}`,
        label: bucket.label,
        family,
        support,
        share,
        predicate: (product: Product) => {
          const value = product[field];
          return typeof value === "number" && bucket.test(value);
        },
      };
    })
    .filter((tag) => tag.share >= minShare && tag.share <= maxShare);
}

export function normalizeContainerType(value: string | null) {
  if (!value) return null;
  const text = value.toLowerCase();
  if (text.includes("flaska")) return "Bottle";
  if (text.includes("burk")) return "Can";
  if (text.includes("box")) return "Box";
  if (text.includes("fat")) return "Keg";
  if (text.includes("pase") || text.includes("påse")) return "Pouch";
  if (text.includes("papp")) return "Carton";
  if (text.includes("multipack")) return "Multipack";
  return null;
}

export function normalizeContainerMaterial(value: string | null) {
  if (!value) return null;
  const text = value.toLowerCase();
  if (text.includes("glas")) return "Glass";
  if (text.includes("burk")) return "Aluminum/Metal";
  if (text.includes("pet") || text.includes("plast")) return "Plastic";
  if (text.includes("box") || text.includes("papp")) return "Paper/Cardboard";
  if (text.includes("pase") || text.includes("påse")) return "Flexible/Plastic";
  if (text.includes("fat")) return "Metal/Keg";
  return null;
}

function countContainerDimensions(products: Product[]) {
  const typeCounts = new Map<string, number>();
  const materialCounts = new Map<string, number>();

  for (const product of products) {
    const packaging =
      typeof product.packagingLevel1 === "string" ? product.packagingLevel1 : null;
    const bottleText =
      typeof product.bottleText === "string" ? product.bottleText : null;

    const type =
      normalizeContainerType(packaging) ?? normalizeContainerType(bottleText);
    const material =
      normalizeContainerMaterial(packaging) ?? normalizeContainerMaterial(bottleText);

    if (type) {
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
    if (material) {
      materialCounts.set(material, (materialCounts.get(material) ?? 0) + 1);
    }
  }

  return { typeCounts, materialCounts };
}

function uniqueTags(tags: BoardTagCandidate[]) {
  return [...new Map(tags.map((tag) => [tag.id, tag])).values()];
}

export function buildCandidateTags(products: Product[]) {
  const categoryLevel2Counts = countByStringField(products, "categoryLevel2");
  const countryCounts = countByStringField(products, "country");
  const packagingCounts = countByStringField(products, "packagingLevel1");
  const {
    typeCounts: containerTypeCounts,
    materialCounts: containerMaterialCounts,
  } = countContainerDimensions(products);

  return uniqueTags([
    ...createStringTags({
      products,
      map: categoryLevel2Counts,
      field: "categoryLevel2",
      family: "beverage",
      prefix: "Beverage",
      limit: 14,
      minShare: 0.02,
      maxShare: 0.35,
    }),
    ...createStringTags({
      products,
      map: countryCounts,
      field: "country",
      family: "geography",
      prefix: "Country",
      limit: 12,
      minShare: 0.02,
      maxShare: 0.3,
    }),
    ...createStringTags({
      products,
      map: packagingCounts,
      field: "packaging",
      family: "container",
      prefix: "Container",
      limit: 8,
      minShare: 0.01,
      maxShare: 0.8,
    }),
    ...createStringTags({
      products,
      map: containerTypeCounts,
      field: "__containerType",
      family: "containerType",
      prefix: "ContainerType",
      limit: 8,
      minShare: 0.005,
      maxShare: 0.95,
    }).map((tag) => ({
      ...tag,
      predicate: (product: Product) => {
        const packaging =
          typeof product.packagingLevel1 === "string" ? product.packagingLevel1 : null;
        const bottleText =
          typeof product.bottleText === "string" ? product.bottleText : null;
        const type =
          normalizeContainerType(packaging) ?? normalizeContainerType(bottleText);
        return type === tag.label.replace("ContainerType:", "");
      },
    })),
    ...createStringTags({
      products,
      map: containerMaterialCounts,
      field: "__containerMaterial",
      family: "containerMaterial",
      prefix: "ContainerMaterial",
      limit: 8,
      minShare: 0.005,
      maxShare: 0.95,
    }).map((tag) => ({
      ...tag,
      predicate: (product: Product) => {
        const packaging =
          typeof product.packagingLevel1 === "string" ? product.packagingLevel1 : null;
        const bottleText =
          typeof product.bottleText === "string" ? product.bottleText : null;
        const material =
          normalizeContainerMaterial(packaging) ??
          normalizeContainerMaterial(bottleText);
        return material === tag.label.replace("ContainerMaterial:", "");
      },
    })),
    ...createBucketTags(
      products,
      "price",
      "price",
      [
        { key: "budget", label: "Price: < 100 SEK", test: (value) => value < 100 },
        {
          key: "mid",
          label: "Price: 100-200 SEK",
          test: (value) => value >= 100 && value < 200,
        },
        {
          key: "premium",
          label: "Price: 200-350 SEK",
          test: (value) => value >= 200 && value < 350,
        },
        {
          key: "fancy",
          label: "Price: 350-700 SEK",
          test: (value) => value >= 350 && value < 700,
        },
      ],
      0.05,
      0.75,
    ),
    ...createBucketTags(
      products,
      "alcoholPercentage",
      "alcohol",
      [
        { key: "light", label: "Alcohol: < 5%", test: (value) => value < 5 },
        {
          key: "medium",
          label: "Alcohol: 5-10%",
          test: (value) => value >= 5 && value < 10,
        },
        {
          key: "strong",
          label: "Alcohol: 10-13%",
          test: (value) => value >= 10 && value < 13,
        },
        {
          key: "veryStrong",
          label: "Alcohol: 13-22%",
          test: (value) => value >= 13 && value < 22,
        },
        {
          key: "liquor",
          label: "Alcohol: liquor (>=22%)",
          test: (value) => value >= 22,
        },
      ],
      0.03,
      0.8,
    ),
    ...createBucketTags(
      products,
      "volume",
      "volume",
      [
        {
          key: "small",
          label: "Volume: 50-330 ml",
          test: (value) => value >= 50 && value < 330,
        },
        {
          key: "standard",
          label: "Volume: 330-500 ml",
          test: (value) => value >= 330 && value < 500,
        },
        {
          key: "party",
          label: "Volume: 500-750 ml",
          test: (value) => value >= 500 && value < 750,
        },
        {
          key: "large",
          label: "Volume: 750-1000 ml",
          test: (value) => value >= 750 && value <= 1000,
        },
      ],
      0.02,
      0.75,
    ),
    ...createBucketTags(
      products,
      "tasteClockSweetness",
      "taste",
      [
        {
          key: "sweetMid",
          label: "Sweetness: medium (3-6)",
          test: (value) => value >= 3 && value <= 6,
        },
        {
          key: "sweetHigh",
          label: "Sweetness: high (7+)",
          test: (value) => value >= 7,
        },
      ],
      0.02,
      0.85,
    ),
    ...createBucketTags(
      products,
      "tasteClockFruitacid",
      "taste",
      [
        {
          key: "acidLow",
          label: "Acidity: low (0-2)",
          test: (value) => value <= 2,
        },
        {
          key: "acidMid",
          label: "Acidity: medium (3-6)",
          test: (value) => value >= 3 && value <= 6,
        },
        {
          key: "acidHigh",
          label: "Acidity: high (7+)",
          test: (value) => value >= 7,
        },
      ],
      0.01,
      0.95,
    ),
    ...createBucketTags(
      products,
      "tasteClockBitter",
      "taste",
      [
        {
          key: "bitterMid",
          label: "Bitterness: medium (3-6)",
          test: (value) => value >= 3 && value <= 6,
        },
        {
          key: "bitterHigh",
          label: "Bitterness: high (7+)",
          test: (value) => value >= 7,
        },
      ],
      0.02,
      0.95,
    ),
    ...createBucketTags(
      products,
      "tasteClockBody",
      "taste",
      [
        {
          key: "bodyMid",
          label: "Body: medium (3-6)",
          test: (value) => value >= 3 && value <= 6,
        },
        {
          key: "bodyHigh",
          label: "Body: full (7+)",
          test: (value) => value >= 7,
        },
      ],
      0.02,
      0.95,
    ),
    ...createBucketTags(
      products,
      "tasteClockRoughness",
      "taste",
      [
        {
          key: "roughMid",
          label: "Roughness: medium (2-4)",
          test: (value) => value >= 2 && value <= 4,
        },
        {
          key: "roughHigh",
          label: "Roughness: high (5+)",
          test: (value) => value >= 5,
        },
      ],
      0.005,
      0.95,
    ),
    ...createBucketTags(
      products,
      "tasteClockSmokiness",
      "taste",
      [
        {
          key: "smokeMid",
          label: "Smokiness: medium (2-4)",
          test: (value) => value >= 2 && value <= 4,
        },
        {
          key: "smokeHigh",
          label: "Smokiness: high (5+)",
          test: (value) => value >= 5,
        },
      ],
      0.001,
      0.95,
    ),
    ...createBucketTags(
      products,
      "tasteClockCasque",
      "taste",
      [
        {
          key: "oakMid",
          label: "Oak/Cask: medium (2-4)",
          test: (value) => value >= 2 && value <= 4,
        },
        {
          key: "oakHigh",
          label: "Oak/Cask: high (5+)",
          test: (value) => value >= 5,
        },
      ],
      0.005,
      0.95,
    ),
  ]);
}

function toFiniteNumber(value: unknown) {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function matchContainerType(product: any, tagId: string) {
  const packaging =
    typeof product?.packagingLevel1 === "string" ? product.packagingLevel1 : null;
  const bottleText =
    typeof product?.bottleText === "string" ? product.bottleText : null;
  const type = normalizeContainerType(packaging) ?? normalizeContainerType(bottleText);
  return type === tagId.slice("ContainerType:".length);
}

function matchContainerMaterial(product: any, tagId: string) {
  const packaging =
    typeof product?.packagingLevel1 === "string" ? product.packagingLevel1 : null;
  const bottleText =
    typeof product?.bottleText === "string" ? product.bottleText : null;
  const material =
    normalizeContainerMaterial(packaging) ?? normalizeContainerMaterial(bottleText);
  return material === tagId.slice("ContainerMaterial:".length);
}

function matchPrice(product: any, tagId: string) {
  const value = toFiniteNumber(product?.price);
  if (value == null) return false;
  const rules: Record<string, (number: number) => boolean> = {
    "price:budget": (number) => number < 100,
    "price:mid": (number) => number >= 100 && number < 200,
    "price:premium": (number) => number >= 200 && number < 350,
    "price:fancy": (number) => number >= 350 && number < 700,
  };
  return rules[tagId]?.(value) ?? false;
}

function matchAlcohol(product: any, tagId: string) {
  const value = toFiniteNumber(product?.alcoholPercentage);
  if (value == null) return false;
  const rules: Record<string, (number: number) => boolean> = {
    "alcohol:light": (number) => number < 5,
    "alcohol:medium": (number) => number >= 5 && number < 10,
    "alcohol:strong": (number) => number >= 10 && number < 13,
    "alcohol:veryStrong": (number) => number >= 13 && number < 22,
    "alcohol:liquor": (number) => number >= 22,
  };
  return rules[tagId]?.(value) ?? false;
}

function matchVolume(product: any, tagId: string) {
  const value = toFiniteNumber(product?.volume);
  if (value == null) return false;
  const rules: Record<string, (number: number) => boolean> = {
    "volume:small": (number) => number >= 50 && number < 330,
    "volume:standard": (number) => number >= 330 && number < 500,
    "volume:party": (number) => number >= 500 && number < 750,
    "volume:large": (number) => number >= 750 && number <= 1000,
  };
  return rules[tagId]?.(value) ?? false;
}

function matchTaste(product: any, tagId: string) {
  const tasteId = tagId.slice("taste:".length);
  const rules: Record<string, { field: string; min?: number; max?: number }> = {
    sweetMid: { field: "tasteClockSweetness", min: 3, max: 6 },
    sweetHigh: { field: "tasteClockSweetness", min: 7 },
    acidLow: { field: "tasteClockFruitacid", max: 2 },
    acidMid: { field: "tasteClockFruitacid", min: 3, max: 6 },
    acidHigh: { field: "tasteClockFruitacid", min: 7 },
    bitterMid: { field: "tasteClockBitter", min: 3, max: 6 },
    bitterHigh: { field: "tasteClockBitter", min: 7 },
    bodyMid: { field: "tasteClockBody", min: 3, max: 6 },
    bodyHigh: { field: "tasteClockBody", min: 7 },
    roughMid: { field: "tasteClockRoughness", min: 2, max: 4 },
    roughHigh: { field: "tasteClockRoughness", min: 5 },
    smokeMid: { field: "tasteClockSmokiness", min: 2, max: 4 },
    smokeHigh: { field: "tasteClockSmokiness", min: 5 },
    oakMid: { field: "tasteClockCasque", min: 2, max: 4 },
    oakHigh: { field: "tasteClockCasque", min: 5 },
  };

  const rule = rules[tasteId];
  const value = toFiniteNumber(product?.[rule?.field || ""]);
  if (!rule || value == null) return false;
  if (rule.min != null && value < rule.min) return false;
  if (rule.max != null && value > rule.max) return false;
  return true;
}

const matchers: Array<{
  prefix: string;
  match: (product: any, tagId: string) => boolean;
}> = [
  {
    prefix: "Country:",
    match: (product, tagId) => product?.country === tagId.slice("Country:".length),
  },
  {
    prefix: "Beverage:",
    match: (product, tagId) =>
      product?.categoryLevel2 === tagId.slice("Beverage:".length),
  },
  {
    prefix: "Container:",
    match: (product, tagId) =>
      product?.packagingLevel1 === tagId.slice("Container:".length),
  },
  { prefix: "ContainerType:", match: matchContainerType },
  { prefix: "ContainerMaterial:", match: matchContainerMaterial },
  { prefix: "price:", match: matchPrice },
  { prefix: "alcohol:", match: matchAlcohol },
  { prefix: "volume:", match: matchVolume },
  { prefix: "taste:", match: matchTaste },
];

export function doesProductMatchTagId(product: any, tagId: string) {
  for (const matcher of matchers) {
    if (tagId.startsWith(matcher.prefix)) {
      return matcher.match(product, tagId);
    }
  }
  return false;
}
