import { VariantType } from 'src/configuration/ufc-v1'

export interface TestCase {
  flag: string;
  variationType: VariantType;
  defaultValue: number | string | boolean | object;
  targetingKey: string;
  attributes: Record<string, number | string | boolean>;
  result: {
    value: number | string | boolean | object;
  }
}
