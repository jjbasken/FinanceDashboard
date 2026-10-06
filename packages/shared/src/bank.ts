import { z } from "zod";

export const CSV_DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY", "YYYY/MM/DD"] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

const column = z.number().int().min(0).max(200);

/** Which CSV columns hold what. Either `amount`, or `debit` and/or `credit`. */
export const csvMappingSchema = z.object({
  hasHeader: z.boolean(),
  date: column,
  dateFormat: z.enum(CSV_DATE_FORMATS),
  payee: column.nullable(),
  notes: column.nullable(),
  amount: column.nullable(),
  debit: column.nullable(),
  credit: column.nullable(),
  /** Flip signs, for files where money spent is positive (common for credit cards). */
  invert: z.boolean(),
});
export type CsvMapping = z.infer<typeof csvMappingSchema>;

export const bankPreviewInput = z.object({ csv: csvMappingSchema.optional() });

export const bankCommitInput = z.object({
  csv: csvMappingSchema.optional(),
  /** Indexes (from the preview) of the items to import or match; others are left out. */
  include: z.array(z.number().int().min(0)).max(50_000),
  /** Category per included new item, by index. Missing means the suggestion. */
  categories: z.record(z.string().regex(/^\d+$/), z.number().int().positive().nullable()).optional(),
});
export type BankCommitInput = z.infer<typeof bankCommitInput>;

export interface BankUpload {
  uploadId: string;
  fileName: string;
  format: "ofx" | "csv";
  accountId: number;
  /** For CSV files: the first rows and a suggested mapping to confirm. */
  csv?: { rows: string[][]; suggested: CsvMapping };
}

export type BankItemStatus = "new" | "duplicate" | "match";

export interface BankItem {
  index: number;
  date: string;
  amount: number;
  payee: string;
  notes: string;
  /** new: will be added; duplicate: already imported; match: will mark an existing transaction as imported. */
  status: BankItemStatus;
  /** The existing transaction a "match" would link to. */
  matchId: number | null;
  matchPayee: string | null;
  matchDate: string | null;
  /** Category from the last transaction with the same payee. */
  suggestedCategoryId: number | null;
}

export interface BankPreview {
  items: BankItem[];
  counts: Record<BankItemStatus, number>;
  /** Rows that couldn't be read (CSV), 1-based line numbers. */
  errors: { line: number; message: string }[];
}
