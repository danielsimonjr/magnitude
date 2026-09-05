/** GGML tensor type block geometry for storage-size estimation. */

export const tensorStorageBytes = (tensorType: number, shape: readonly number[]): number | undefined => {
  if (shape.length === 0) {
    return undefined
  }
  const [rowWidth, ...rest] = shape
  const geometry = blockGeometry(tensorType)
  const elemsPerBlock = geometry[0]
  const bytesPerBlock = geometry[1]
  if (elemsPerBlock === 0) {
    return undefined
  }
  const rows = rest.reduce((product, dimension) => product * dimension, 1)
  const blocksPerRow = Math.ceil(rowWidth / elemsPerBlock)
  const total = blocksPerRow * rows * bytesPerBlock
  if (!Number.isFinite(total)) {
    return undefined
  }
  return total
}

const blockGeometry = (tag: number): [number, number] => {
  switch (tag) {
    case 0:
      return [1, 4]
    case 1:
    case 30:
      return [1, 2]
    case 28:
      return [1, 8]
    case 26:
      return [1, 4]
    case 25:
      return [1, 2]
    case 24:
      return [1, 1]
    case 2:
      return [32, 18]
    case 3:
      return [32, 20]
    case 6:
      return [32, 22]
    case 7:
      return [32, 24]
    case 8:
      return [32, 34]
    case 9:
      return [32, 36]
    case 10:
      return [256, 84]
    case 11:
      return [256, 110]
    case 12:
      return [256, 144]
    case 13:
      return [256, 176]
    case 14:
      return [256, 210]
    case 15:
      return [256, 292]
    case 16:
      return [256, 66]
    case 17:
      return [256, 70]
    case 18:
      return [256, 74]
    case 19:
      return [256, 50]
    case 20:
      return [32, 18]
    case 21:
      return [256, 90]
    case 22:
      return [256, 82]
    case 23:
      return [256, 98]
    case 29:
      return [256, 56]
    case 34:
      return [256, 42]
    case 35:
      return [256, 66]
    default:
      return [1, 2]
  }
}

export type GgufFileType =
  | "AllF32"
  | "MostlyF16"
  | "MostlyQ4_0"
  | "MostlyQ4_1"
  | "MostlyQ5_0"
  | "MostlyQ5_1"
  | "MostlyQ8_0"
  | "MostlyQ2_K"
  | "MostlyQ3_KSmall"
  | "MostlyQ3_KMedium"
  | "MostlyQ3_KLarge"
  | "MostlyQ4_KSmall"
  | "MostlyQ4_KMedium"
  | "MostlyQ5_KSmall"
  | "MostlyQ5_KMedium"
  | "MostlyQ6_K"
  | "MostlyQ8_K"
  | "MostlyIq2Xxs"
  | "MostlyIq2Xs"
  | "MostlyIq3Xxs"
  | "MostlyIq1Small"
  | "MostlyIq4Nl"
  | "MostlyIq3Small"
  | "MostlyIq2Small"
  | "MostlyIq4Xs"
  | "MostlyIq1Medium"
  | "MostlyBf16"
  | "MostlyTq1_0"
  | "MostlyTq2_0"
  | "MostlyIq3Xs"
  | "MostlyIq3Medium"
  | "MostlyIq2Medium"
  | "MostlyIq2Xxs"
  | "MostlyMxfp4Moe"
  | "MostlyNvfp4"
  | "Guessed"
  | "Unknown"

export const fileTypeFromU32 = (value: number): GgufFileType | undefined => {
  const mapping: Record<number, GgufFileType> = {
    0: "AllF32",
    1: "MostlyF16",
    2: "MostlyQ4_0",
    3: "MostlyQ4_1",
    4: "MostlyQ5_0",
    5: "MostlyQ5_1",
    6: "MostlyQ8_0",
    7: "MostlyQ2_K",
    8: "MostlyQ3_KSmall",
    9: "MostlyQ3_KMedium",
    10: "MostlyQ3_KLarge",
    11: "MostlyQ4_KSmall",
    12: "MostlyQ4_KMedium",
    13: "MostlyQ5_KSmall",
    14: "MostlyQ5_KMedium",
    15: "MostlyQ6_K",
    16: "MostlyQ8_K",
    17: "MostlyIq2Xxs",
    18: "MostlyIq2Xs",
    19: "MostlyIq3Xxs",
    20: "MostlyIq1Small",
    21: "MostlyIq4Nl",
    22: "MostlyIq3Small",
    23: "MostlyIq2Small",
    24: "MostlyIq4Xs",
    25: "MostlyIq1Medium",
    26: "MostlyBf16",
    27: "MostlyTq1_0",
    28: "MostlyTq2_0",
    29: "MostlyIq3Xs",
    30: "MostlyIq3Medium",
    31: "MostlyIq2Medium",
    32: "MostlyMxfp4Moe",
    33: "MostlyNvfp4",
    99: "Guessed",
  }
  return mapping[value] ?? "Unknown"
}

export const fileTypeName = (fileType: GgufFileType): string | undefined => {
  switch (fileType) {
    case "AllF32":
      return "F32"
    case "MostlyF16":
      return "F16"
    case "MostlyBf16":
      return "BF16"
    case "MostlyQ8_0":
      return "Q8_0"
    case "MostlyQ6_K":
      return "Q6_K"
    case "MostlyQ5_0":
    case "MostlyQ5_1":
    case "MostlyQ5_KSmall":
    case "MostlyQ5_KMedium":
      return "Q5"
    case "MostlyQ4_0":
    case "MostlyQ4_1":
    case "MostlyQ4_KSmall":
    case "MostlyQ4_KMedium":
    case "MostlyIq4Nl":
    case "MostlyIq4Xs":
    case "MostlyMxfp4Moe":
    case "MostlyNvfp4":
      return "Q4"
    case "MostlyQ3_KSmall":
    case "MostlyQ3_KMedium":
    case "MostlyQ3_KLarge":
    case "MostlyIq3Xs":
    case "MostlyIq3Xxs":
    case "MostlyIq3Small":
    case "MostlyIq3Medium":
      return "Q3"
    case "MostlyQ2_K":
    case "MostlyIq2Xxs":
    case "MostlyIq2Xs":
    case "MostlyIq2Small":
    case "MostlyIq2Medium":
    case "MostlyTq2_0":
      return "Q2"
    case "MostlyIq1Small":
    case "MostlyIq1Medium":
    case "MostlyTq1_0":
      return "Q1"
    case "Guessed":
    case "Unknown":
      return undefined
  }
}

export const friendlyQuantizationName = (fileType: GgufFileType): string => {
  switch (fileType) {
    case "AllF32":
      return "32-bit"
    case "MostlyF16":
    case "MostlyBf16":
      return "16-bit"
    case "MostlyQ8_0":
      return "8-bit"
    case "MostlyQ6_K":
      return "6-bit"
    case "MostlyQ5_0":
    case "MostlyQ5_1":
    case "MostlyQ5_KSmall":
    case "MostlyQ5_KMedium":
      return "5-bit"
    case "MostlyQ4_0":
    case "MostlyQ4_1":
    case "MostlyQ4_KSmall":
    case "MostlyQ4_KMedium":
    case "MostlyIq4Nl":
    case "MostlyIq4Xs":
    case "MostlyMxfp4Moe":
    case "MostlyNvfp4":
      return "4-bit"
    case "MostlyQ3_KSmall":
    case "MostlyQ3_KMedium":
    case "MostlyQ3_KLarge":
    case "MostlyIq3Xs":
    case "MostlyIq3Xxs":
    case "MostlyIq3Small":
    case "MostlyIq3Medium":
      return "3-bit"
    case "MostlyQ2_K":
    case "MostlyIq2Xxs":
    case "MostlyIq2Xs":
    case "MostlyIq2Small":
    case "MostlyIq2Medium":
    case "MostlyTq2_0":
      return "2-bit"
    case "MostlyIq1Small":
    case "MostlyIq1Medium":
    case "MostlyTq1_0":
      return "1-bit"
    case "Guessed":
    case "Unknown":
      return "unknown"
  }
  return "unknown"
}
