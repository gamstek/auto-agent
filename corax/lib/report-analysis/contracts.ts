import { z } from 'zod';
import { modelIds } from './g12/models';

const pressure = z.number().min(0).max(1.1);
const pressureRange = { minPP0: pressure.optional(), maxPP0: pressure.optional() };
const point = z.object({ pp0: pressure.positive(), uptake: z.number().nonnegative() });
export const modelIdSchema = z.enum(modelIds);

export const isothermSchema = z
  .object({
    gas: z.string().trim().min(1).max(40),
    temperatureK: z.number().positive().max(1000),
    uptakeUnit: z.enum(['cm3(STP)/g', 'mmol/g']),
    branches: z
      .object({
        adsorption: z.array(point.strict()).max(2000).default([]),
        desorption: z.array(point.strict()).max(2000).default([]),
      })
      .strict(),
  })
  .strict();

// Parsed PDF points also carry page and row metadata. Validate the same values
// without discarding that provenance from the calculation input.
export const calculationInputSchema = isothermSchema
  .extend({
    branches: z
      .object({
        adsorption: z.array(point.loose()).max(2000),
        desorption: z.array(point.loose()).max(2000),
      })
      .strict(),
  })
  .strip();

export const calculationOptionsSchema = z.object({
  adsId: z.string().trim().min(1).max(100).optional(),
  bet: z
    .object({
      ...pressureRange,
      crossSectionNm2: z.number().positive().max(10).optional(),
      betsi: z
        .object({
          minPoints: z.number().int().min(3).max(2000).optional(),
          minRSquared: z.number().min(0).max(1).optional(),
          maxPressureErrorPercent: z.number().min(0).max(100).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  nldft: z
    .array(
      z
        .object({
          modelId: modelIdSchema,
          branch: z.enum(['adsorption', 'desorption']).optional(),
          ...pressureRange,
          lambda: z.number().min(0).max(1000).optional(),
          poreWidthEdgesNm: z.array(z.number().positive().max(10000)).min(1).max(30).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(4)
    .optional(),
  bjh: z
    .array(
      z
        .object({
          branch: z.enum(['adsorption', 'desorption']),
          ...pressureRange,
          minDiameterNm: z.number().positive().optional(),
          maxDiameterNm: z.number().positive().optional(),
          thickness: z.enum(['harkins-jura', 'halsey']).optional(),
          correction: z.enum(['standard', 'kjs']).optional(),
          fraction: z.number().min(0).max(1).optional(),
          kelvinFactorNm: z.number().positive().optional(),
        })
        .strict(),
    )
    .min(1)
    .max(2)
    .optional(),
});

export type CalculationOptions = z.infer<typeof calculationOptionsSchema>;
