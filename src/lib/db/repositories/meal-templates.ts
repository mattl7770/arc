/**
 * The meal-templates data layer (0018): reusable named meals a user builds once
 * and logs repeatedly ("Protein oats", "Post-workout shake").
 *
 * A template is a STAMP, not a link: logging from it creates independent
 * `meals` + `meal_items` (via the nutrition repo's logMealWithItems), so
 * editing or deleting a template never rewrites meals already logged from it —
 * the same snapshot discipline meal_items already follow. Templates can be
 * built from scratch or captured retroactively from a logged meal
 * (saveMealAsTemplate — MacroFactor's "bundle these into a combo").
 *
 * Depends only on the {@link Database} interface — never op-sqlite — so it runs
 * on device and against node:sqlite in db/nutrition-v2.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import { normalizeFoodName } from './foods';
import { listMealItems, logMealWithItems } from './nutrition';
import type {
  MealTemplateItemRow,
  MealTemplateRow,
  MealTemplateSummary,
  NewMealItem,
  NewMealTemplate,
} from '@/lib/nutrition/types';

function insertTemplateItem(db: Database, templateId: string, item: NewMealItem): string {
  const id = newId(db);
  db.run(
    `INSERT INTO meal_template_items (id, template_id, food_id, name, grams, serving_qty,
       kcal, protein_g, carbs_g, fat_g, fiber_g, micros)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      templateId,
      item.food_id ?? null,
      item.name,
      item.grams ?? null,
      item.serving_qty ?? null,
      item.kcal ?? null,
      item.protein_g ?? null,
      item.carbs_g ?? null,
      item.fat_g ?? null,
      item.fiber_g ?? null,
      item.micros ?? null,
    ]
  );
  return id;
}

/** Create a template and its items in one transaction; returns the new id. */
export function createTemplate(db: Database, template: NewMealTemplate): string {
  const id = newId(db);
  db.transaction(() => {
    db.run(`INSERT INTO meal_templates (id, name, name_norm, notes) VALUES (?, ?, ?, ?)`, [
      id,
      template.name,
      normalizeFoodName(template.name),
      template.notes ?? null,
    ]);
    for (const item of template.items) insertTemplateItem(db, id, item);
  });
  return id;
}

/**
 * Capture a logged meal as a reusable template — its items snapshot across
 * (including micros), confidence dropped (a template is a curated recipe, not
 * an estimate). Returns the new template id, or null if the meal is gone or
 * has no items (a free-form meal has nothing itemized to templatize).
 */
export function saveMealAsTemplate(db: Database, mealId: string, name: string): string | null {
  const items = listMealItems(db, mealId);
  if (items.length === 0) return null;
  return createTemplate(db, {
    name,
    items: items.map((i) => ({
      food_id: i.food_id,
      name: i.name,
      grams: i.grams,
      serving_qty: i.serving_qty,
      kcal: i.kcal,
      protein_g: i.protein_g,
      carbs_g: i.carbs_g,
      fat_g: i.fat_g,
      fiber_g: i.fiber_g,
      micros: i.micros,
    })),
  });
}

export function getTemplate(db: Database, id: string): MealTemplateRow | undefined {
  return db.get<MealTemplateRow>('SELECT * FROM meal_templates WHERE id = ?', [id]);
}

export function listTemplateItems(db: Database, templateId: string): MealTemplateItemRow[] {
  return db.all<MealTemplateItemRow>(
    'SELECT * FROM meal_template_items WHERE template_id = ? ORDER BY created_at, id',
    [templateId]
  );
}

/** Templates newest-first, each with its rolled-up totals + item count. */
export function listTemplates(db: Database): MealTemplateSummary[] {
  const rows = db.all<
    MealTemplateRow & {
      kcal: number | null;
      protein_g: number | null;
      carbs_g: number | null;
      fat_g: number | null;
      item_count: number;
    }
  >(
    `SELECT t.*,
            sum(ti.kcal)      AS kcal,
            sum(ti.protein_g) AS protein_g,
            sum(ti.carbs_g)   AS carbs_g,
            sum(ti.fat_g)     AS fat_g,
            count(ti.id)      AS item_count
     FROM meal_templates t
     LEFT JOIN meal_template_items ti ON ti.template_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC, t.id`
  );
  return rows.map(({ kcal, protein_g, carbs_g, fat_g, item_count, ...template }) => ({
    template,
    kcal,
    protein_g,
    carbs_g,
    fat_g,
    itemCount: item_count,
  }));
}

export function renameTemplate(
  db: Database,
  id: string,
  meta: { name: string; notes?: string | null }
): void {
  db.run('UPDATE meal_templates SET name = ?, name_norm = ?, notes = ? WHERE id = ?', [
    meta.name,
    normalizeFoodName(meta.name),
    meta.notes ?? null,
    id,
  ]);
}

/** Delete a template; its items follow via ON DELETE CASCADE. Logged meals are
 * untouched — the template was only ever a stamp. */
export function deleteTemplate(db: Database, id: string): void {
  db.run('DELETE FROM meal_templates WHERE id = ?', [id]);
}

/**
 * Log a real meal from a template onto `date` at `time`. The template's items
 * are copied as fresh meal_items (snapshots, not links), so the logged meal
 * stands on its own and later template edits never touch it. The meal is named
 * after the template. Returns the new meal id, or null if the template is gone
 * or empty.
 */
export function logMealFromTemplate(
  db: Database,
  templateId: string,
  date: string,
  time: string | null
): string | null {
  const template = getTemplate(db, templateId);
  if (!template) return null;
  const items = listTemplateItems(db, templateId);
  if (items.length === 0) return null;
  return logMealWithItems(db, {
    date,
    time,
    name: template.name,
    items: items.map((i) => ({
      food_id: i.food_id,
      name: i.name,
      grams: i.grams,
      serving_qty: i.serving_qty,
      kcal: i.kcal,
      protein_g: i.protein_g,
      carbs_g: i.carbs_g,
      fat_g: i.fat_g,
      fiber_g: i.fiber_g,
      micros: i.micros,
    })),
  }).mealId;
}
