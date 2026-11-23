import type { Generated } from "kysely";

export interface SchemaMetaTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export interface Database {
  schema_meta: SchemaMetaTable;
}
