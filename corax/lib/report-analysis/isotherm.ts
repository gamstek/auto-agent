export type Branch = 'adsorption' | 'desorption';
export type Point = { pp0: number; uptake: number };
export type UptakeUnit = 'cm3(STP)/g' | 'mmol/g';

export type Isotherm = {
  gas?: string;
  temperatureK?: number;
  branches: Record<Branch, Point[]>;
  uptakeUnit: UptakeUnit;
};

export const stpVolumePerMmol = 22.414;
