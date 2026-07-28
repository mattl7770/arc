-- ============================================================================
-- ARC 0016 — nutrition sub-app: the starter food catalog (seed data)
--
-- ~187 curated staple foods so search/quick-add works from day one, before
-- any custom foods, AI entries, or barcode hits exist. Values are per-100 g,
-- authored from USDA FoodData Central knowledge (Foundation Foods / SR Legacy —
-- public domain, CC0); household servings carry their gram weights; micros are
-- the longevity shortlist, present only where the source is confident (absent
-- beats guessed — docs/nutrition-subapp.md §3). Restaurant-archetype rows are
-- deliberate approximations to absorb eating-out logging until the AI path
-- lands; every row is user-editable in-app.
--
-- Data-only migration: no schema changes. Ids are fixed v4 UUIDs minted at
-- authoring time, so every install shares them (a future catalog-update
-- migration can reference rows by id). Catalog updates are NEW append-only
-- migrations — a shipped migration is never edited.
-- The migration runner stamps PRAGMA user_version = 16 after applying this file.
-- ============================================================================

-- --- Proteins ------------------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('eae98e7f-983c-4396-bdb3-4f0d3a59c24c', 'Chicken breast, cooked', 'chicken breast, cooked', '1 breast', 172, 165, 31, 0, 3.6, 0, NULL, 'seed'),
  ('ff3e2b47-e9d5-47a9-92e7-199a9620add8', 'Chicken thigh, cooked', 'chicken thigh, cooked', '1 thigh', 116, 209, 26, 0, 10.9, 0, NULL, 'seed'),
  ('8d3232fe-bd87-4d64-b7af-169dcda3934b', 'Rotisserie chicken, meat', 'rotisserie chicken, meat', '1 cup', 140, 205, 24, 0, 12, 0, NULL, 'seed'),
  ('75790b9e-f581-4b46-80b0-a12703b871b7', 'Ground beef 90% lean, cooked', 'ground beef 90% lean, cooked', '4 oz cooked', 113, 217, 26, 0, 11.8, 0, NULL, 'seed'),
  ('d9d0ec79-e17b-4c46-bd96-94fcb3d7f0d6', 'Ground beef 80% lean, cooked', 'ground beef 80% lean, cooked', '4 oz cooked', 113, 254, 25.8, 0, 15.9, 0, NULL, 'seed'),
  ('aac79288-faed-4e59-a3e5-6bf4d343ccda', 'Ground turkey 93% lean, cooked', 'ground turkey 93% lean, cooked', '4 oz cooked', 113, 213, 27, 0, 11.5, 0, NULL, 'seed'),
  ('26a3b03d-58db-4ea4-a957-e6d100615be7', 'Ribeye steak, cooked', 'ribeye steak, cooked', '1 steak', 221, 291, 24, 0, 21, 0, NULL, 'seed'),
  ('af0bbe29-f8de-4257-b490-7bd7b02204e0', 'Sirloin steak, cooked', 'sirloin steak, cooked', '6 oz', 170, 183, 27, 0, 7.6, 0, NULL, 'seed'),
  ('ca572f42-9a73-43cc-b141-00b91ad03b4e', 'Pork chop, cooked', 'pork chop, cooked', '1 chop', 145, 231, 25, 0, 14, 0, NULL, 'seed'),
  ('ad1c19da-f6f1-45a2-b80b-57d2b1fe6cc7', 'Pork tenderloin, cooked', 'pork tenderloin, cooked', '4 oz', 113, 143, 26, 0, 3.5, 0, NULL, 'seed'),
  ('cc5968fe-aec4-4019-b71d-b3c5f0c30585', 'Bacon, cooked', 'bacon, cooked', '1 slice', 8, 541, 37, 1.4, 42, 0, '{"sodium_mg":1717}', 'seed'),
  ('da68ac3d-5aa7-490e-bdf3-a20f4e155632', 'Turkey breast, roasted', 'turkey breast, roasted', '4 oz', 113, 147, 30, 0, 2, 0, NULL, 'seed'),
  ('547f4c65-8930-4b40-8547-2159f600bb40', 'Deli turkey', 'deli turkey', '3 slices', 57, 104, 16.9, 3.5, 1.7, 0, '{"sodium_mg":1015}', 'seed'),
  ('aae78a4b-386e-4181-acb2-d35572783bba', 'Beef jerky', 'beef jerky', '1 oz', 28, 410, 33, 11, 26, 0, '{"sodium_mg":1785}', 'seed'),
  ('7a87a504-3a36-4be0-ba4e-4e5185089f61', 'Beef liver, cooked', 'beef liver, cooked', '4 oz', 113, 175, 26.5, 5.1, 4.7, 0, '{"iron_mg":6.2,"b12_mcg":70,"folate_mcg":253}', 'seed'),
  ('d40d6c2f-3081-4615-94d8-c5340961504f', 'Salmon, cooked', 'salmon, cooked', '1 fillet', 154, 206, 22, 0, 12, 0, '{"omega3_g":2.2,"vitamin_d_mcg":14}', 'seed'),
  ('e62bff84-0f58-4e22-b689-2318e6ec463d', 'Tuna, canned in water', 'tuna, canned in water', '1 can', 142, 116, 26, 0, 0.8, 0, NULL, 'seed'),
  ('eb8b942b-120e-4f38-815e-9b08861dc553', 'Cod, cooked', 'cod, cooked', '1 fillet', 180, 105, 23, 0, 0.9, 0, NULL, 'seed'),
  ('4d2fc5b0-31dd-48f3-84e2-caddb1bf3dcd', 'Tilapia, cooked', 'tilapia, cooked', '1 fillet', 87, 128, 26, 0, 2.7, 0, NULL, 'seed'),
  ('97d5c240-6a63-4126-8306-a31d413ad4ce', 'Shrimp, cooked', 'shrimp, cooked', '3 oz', 85, 99, 24, 0.2, 0.3, 0, NULL, 'seed'),
  ('8f3f350f-7234-4594-89c2-60ccb80a7bff', 'Sardines, canned in oil', 'sardines, canned in oil', '1 can', 92, 208, 25, 0, 11.5, 0, '{"omega3_g":1.4,"calcium_mg":382,"vitamin_d_mcg":4.8}', 'seed'),
  ('bf490ade-7ccb-4ae5-9863-ff3ac0311c6d', 'Oysters, cooked', 'oysters, cooked', '6 medium', 84, 102, 10.5, 6, 3.4, 0, '{"zinc_mg":78,"b12_mcg":28,"iron_mg":7}', 'seed'),
  ('75e6fba5-e89c-4ad8-b560-4d3982d2d0fe', 'Egg, whole', 'egg, whole', '1 large egg', 50, 155, 12.6, 1.1, 10.6, 0, '{"vitamin_d_mcg":2.2,"b12_mcg":1.1}', 'seed'),
  ('792a328d-60fd-4457-b75e-d8ad436afdb6', 'Egg white', 'egg white', '1 white', 33, 52, 10.9, 0.7, 0.2, 0, NULL, 'seed'),
  ('9ae9d8a1-d704-48dd-8f8f-e608c521dbaa', 'Scrambled eggs, with butter', 'scrambled eggs, with butter', '2 eggs', 122, 149, 10, 1.6, 11, 0, NULL, 'seed'),
  ('59a4616b-e796-4612-bf7c-500027ccdc10', 'Whey protein powder', 'whey protein powder', '1 scoop', 30, 400, 80, 8, 6, 0, NULL, 'seed'),
  ('40c5f982-df20-4a36-8df8-8270a41d8675', 'Tofu, firm', 'tofu, firm', '1/2 cup', 126, 144, 15.5, 4.3, 8.7, 2.3, '{"calcium_mg":350}', 'seed'),
  ('39f3470b-703f-4c5b-9eb1-16feb730dedb', 'Tempeh', 'tempeh', '1/2 cup', 83, 192, 20.3, 7.6, 10.8, NULL, NULL, 'seed'),
  ('866916aa-7693-4908-8e92-57e050410e14', 'Lentils, cooked', 'lentils, cooked', '1 cup', 198, 116, 9, 20, 0.4, 7.9, '{"iron_mg":3.3,"folate_mcg":181,"potassium_mg":369}', 'seed'),
  ('1b07915c-50f2-49a1-8c30-682dc32041b2', 'Black beans, cooked', 'black beans, cooked', '1 cup', 172, 132, 8.9, 23.7, 0.5, 8.7, '{"folate_mcg":149,"magnesium_mg":70}', 'seed'),
  ('fc238869-aa89-40dc-b9d8-e14a53a2925f', 'Chickpeas, cooked', 'chickpeas, cooked', '1 cup', 164, 164, 8.9, 27.4, 2.6, 7.6, '{"folate_mcg":172}', 'seed'),
  ('5e6c7a14-91a5-4b5e-9d3b-fe36ae71695f', 'Edamame, shelled', 'edamame, shelled', '1 cup', 155, 121, 11.9, 8.9, 5.2, 5.2, '{"folate_mcg":311}', 'seed');

-- --- Dairy ---------------------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('38c195ed-052d-4d64-9a7b-33477c363060', 'Greek yogurt, nonfat plain', 'greek yogurt, nonfat plain', '1 cup', 245, 59, 10.2, 3.6, 0.4, 0, '{"calcium_mg":110}', 'seed'),
  ('8f85279e-5e48-4472-9f94-e0a8c27af9e6', 'Greek yogurt, whole milk', 'greek yogurt, whole milk', '1 cup', 245, 97, 9, 3.9, 5, 0, '{"calcium_mg":100}', 'seed'),
  ('8d040f8c-8c0d-4263-8a8d-a65cd3f1e7ed', 'Skyr, plain', 'skyr, plain', '1 cup', 245, 63, 11, 4, 0.2, 0, '{"calcium_mg":110}', 'seed'),
  ('d4dddf05-ccff-4afb-96c0-8bd4b29f1904', 'Cottage cheese, 2%', 'cottage cheese, 2%', '1 cup', 226, 84, 11, 4.3, 2.3, 0, '{"calcium_mg":91,"sodium_mg":321}', 'seed'),
  ('f04d98e4-0beb-47be-aad1-dd9537b019cc', 'Kefir, plain', 'kefir, plain', '1 cup', 243, 41, 3.8, 4.5, 0.9, 0, '{"calcium_mg":130}', 'seed'),
  ('9c1505e8-9cce-4687-ab29-c78d12e186fc', 'Whole milk', 'whole milk', '1 cup', 244, 61, 3.2, 4.8, 3.3, 0, '{"calcium_mg":113,"vitamin_d_mcg":1.3}', 'seed'),
  ('9b332ecd-5eb0-4555-ac44-9d607c207d5b', '2% milk', '2% milk', '1 cup', 244, 50, 3.3, 4.8, 2, 0, '{"calcium_mg":120,"vitamin_d_mcg":1.2}', 'seed'),
  ('52034b12-4a93-4e95-883e-a67ebf352940', 'Skim milk', 'skim milk', '1 cup', 245, 34, 3.4, 5, 0.1, 0, '{"calcium_mg":122}', 'seed'),
  ('2c4dd169-b4c2-4327-bcc4-0506a1c2c693', 'Oat milk', 'oat milk', '1 cup', 240, 48, 0.8, 7.5, 1.5, 0.8, '{"calcium_mg":148}', 'seed'),
  ('20205950-2b4a-4d5b-83b3-859d79a39d77', 'Almond milk, unsweetened', 'almond milk, unsweetened', '1 cup', 240, 15, 0.5, 1.3, 1.1, 0.3, '{"calcium_mg":184}', 'seed'),
  ('7fe14c52-2f6c-4ff8-88ba-b2f0665a4813', 'Cheddar cheese', 'cheddar cheese', '1 oz', 28, 403, 24.9, 1.3, 33.1, 0, '{"calcium_mg":721,"sodium_mg":621}', 'seed'),
  ('bf4b362a-1ff8-43ca-88f4-c162c37f2b40', 'Mozzarella, part-skim', 'mozzarella, part-skim', '1 oz', 28, 254, 24.3, 2.8, 15.9, 0, '{"calcium_mg":782}', 'seed'),
  ('7adea4da-b517-4940-9f4f-0e88c8c81a1d', 'Parmesan, grated', 'parmesan, grated', '1 tbsp', 5, 431, 38.5, 4.1, 28.6, 0, '{"calcium_mg":1109,"sodium_mg":1529}', 'seed'),
  ('c46dff40-2ae2-4121-a576-b6a481999cdd', 'Feta cheese', 'feta cheese', '1 oz', 28, 264, 14.2, 4.1, 21.3, 0, '{"sodium_mg":917,"calcium_mg":493}', 'seed'),
  ('ac74be27-ad49-4929-9351-c8b68a3e1e51', 'Cream cheese', 'cream cheese', '1 tbsp', 15, 342, 5.9, 5.5, 34.2, 0, NULL, 'seed'),
  ('dc16dca5-7fbd-44b7-b36f-60419d3deee1', 'Heavy cream', 'heavy cream', '1 tbsp', 15, 340, 2.8, 2.7, 36.1, 0, NULL, 'seed'),
  ('5b173f5d-819f-40d4-bc06-ad5832d35ceb', 'Half and half', 'half and half', '1 tbsp', 15, 131, 3.1, 4.3, 11.5, 0, NULL, 'seed'),
  ('06f1ae51-948d-4a39-9c9a-9f527ea05b89', 'Sour cream', 'sour cream', '1 tbsp', 12, 198, 2.4, 4.6, 19.4, 0, NULL, 'seed'),
  ('9bde147f-58e0-4588-a4be-22a6a2ef82ae', 'Ice cream, vanilla', 'ice cream, vanilla', '1/2 cup', 66, 207, 3.5, 23.6, 11, 0.7, NULL, 'seed');

-- --- Grains & starches ---------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('c9b7bfed-5ce4-448a-b625-95e51f9777b1', 'White rice, cooked', 'white rice, cooked', '1 cup', 158, 130, 2.7, 28.2, 0.3, 0.4, NULL, 'seed'),
  ('271fe293-d522-476a-9cc5-72b304f929ae', 'Brown rice, cooked', 'brown rice, cooked', '1 cup', 195, 112, 2.3, 23.5, 0.8, 1.8, '{"magnesium_mg":39}', 'seed'),
  ('4d3b0489-017b-48b1-bccd-c40fe4c9775d', 'Quinoa, cooked', 'quinoa, cooked', '1 cup', 185, 120, 4.4, 21.3, 1.9, 2.8, '{"magnesium_mg":64,"folate_mcg":42}', 'seed'),
  ('0f0c44db-f8ca-4203-a16b-08333cade1e1', 'Oats, rolled, dry', 'oats, rolled, dry', '1/2 cup dry', 40, 379, 13.2, 67.7, 6.5, 10.1, '{"magnesium_mg":138,"iron_mg":4.3}', 'seed'),
  ('166025c9-e8a4-4744-b2e4-a7f4509e3f10', 'Oatmeal, cooked with water', 'oatmeal, cooked with water', '1 cup', 234, 71, 2.5, 12, 1.5, 1.7, NULL, 'seed'),
  ('0a5b7a50-3720-468b-aef8-536184e75650', 'Potato, baked with skin', 'potato, baked with skin', '1 medium', 173, 93, 2.5, 21.2, 0.1, 2.2, '{"potassium_mg":535}', 'seed'),
  ('ef953d0a-29ac-45d3-8de7-09fc628b2924', 'Sweet potato, baked', 'sweet potato, baked', '1 medium', 114, 90, 2, 20.7, 0.2, 3.3, '{"potassium_mg":475}', 'seed'),
  ('ae48cdf4-9ea1-49d8-88f0-0395934b9fe3', 'White bread', 'white bread', '1 slice', 28, 265, 9, 49, 3.2, 2.7, '{"sodium_mg":490}', 'seed'),
  ('db4a8318-4153-4eff-880c-97b93ef5dd93', 'Whole wheat bread', 'whole wheat bread', '1 slice', 32, 247, 13, 41, 3.4, 6, '{"sodium_mg":450}', 'seed'),
  ('0050bcbc-56c1-4012-a154-0cab179cdaab', 'Sourdough bread', 'sourdough bread', '1 slice', 50, 289, 11.7, 56, 1.8, 2.4, '{"sodium_mg":513}', 'seed'),
  ('59201736-b259-41fd-872b-8b1da2cbcfff', 'Bagel, plain', 'bagel, plain', '1 bagel', 105, 257, 10.2, 50.5, 1.7, 2.1, '{"sodium_mg":430}', 'seed'),
  ('593b9038-28dc-46d7-80d8-365fb45b0ed1', 'Flour tortilla', 'flour tortilla', '1 tortilla', 49, 312, 8.5, 51, 7.9, 2.6, '{"sodium_mg":736}', 'seed'),
  ('b3ca1a3d-ba2d-4249-8cdb-f6b32b3fb297', 'Corn tortilla', 'corn tortilla', '1 tortilla', 26, 218, 5.7, 44.6, 2.9, 6.3, NULL, 'seed'),
  ('b3099cba-51cf-4dbe-9289-839e90d28043', 'Pasta, cooked', 'pasta, cooked', '1 cup', 140, 158, 5.8, 30.9, 0.9, 1.8, NULL, 'seed'),
  ('69aaffaa-bd15-418a-8c2a-ce38f94e5071', 'Chickpea pasta, dry', 'chickpea pasta, dry', '2 oz dry', 56, 339, 23, 56, 6, 9, NULL, 'seed'),
  ('bbd3a3e0-1450-4617-9d8e-e3849d30baf0', 'Couscous, cooked', 'couscous, cooked', '1 cup', 157, 112, 3.8, 23.2, 0.2, 1.4, NULL, 'seed'),
  ('63cb6cb8-56a2-49cf-ae25-f074a391a9c2', 'Granola', 'granola', '1/2 cup', 61, 471, 10, 64, 20, 7, NULL, 'seed'),
  ('dacba25e-0ade-4e84-9cd9-df29896b441d', 'Corn flakes cereal', 'corn flakes cereal', '1 cup', 28, 357, 7.5, 84, 0.4, 3, '{"sodium_mg":729,"iron_mg":28.9}', 'seed'),
  ('1b4ff39a-8ed8-441d-bd54-1e861b3fa10c', 'Saltine crackers', 'saltine crackers', '5 crackers', 15, 421, 9, 71, 9, 3, '{"sodium_mg":941}', 'seed'),
  ('fb193635-80a3-4234-9a20-f6d016a3aee0', 'Rice cakes', 'rice cakes', '1 cake', 9, 387, 8.2, 81.5, 2.8, 4.2, NULL, 'seed'),
  ('7bd65787-29f6-4aa1-b414-4d64c3a967a5', 'Popcorn, air-popped', 'popcorn, air-popped', '3 cups', 24, 387, 12.9, 77.8, 4.5, 14.5, NULL, 'seed');

-- --- Fruit ---------------------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('9c7f5c00-7cb3-441b-ba7d-e3a0c3a2b0a3', 'Banana', 'banana', '1 medium', 118, 89, 1.1, 22.8, 0.3, 2.6, '{"potassium_mg":358}', 'seed'),
  ('5643a490-ac20-4f7b-a5e1-96e053d3dfe6', 'Apple', 'apple', '1 medium', 182, 52, 0.3, 13.8, 0.2, 2.4, NULL, 'seed'),
  ('722c7cef-0a16-4d03-b221-0c36cce2a517', 'Orange', 'orange', '1 medium', 131, 47, 0.9, 11.8, 0.1, 2.4, '{"vitamin_c_mg":53,"folate_mcg":30}', 'seed'),
  ('bf3fe716-0174-4c64-896d-9ed986725c05', 'Blueberries', 'blueberries', '1 cup', 148, 57, 0.7, 14.5, 0.3, 2.4, '{"vitamin_c_mg":10}', 'seed'),
  ('00f63e79-37a6-4061-9391-634906039031', 'Strawberries', 'strawberries', '1 cup', 152, 32, 0.7, 7.7, 0.3, 2, '{"vitamin_c_mg":59}', 'seed'),
  ('8f023dd4-454c-4753-9403-1145e89be0a3', 'Raspberries', 'raspberries', '1 cup', 123, 52, 1.2, 11.9, 0.7, 6.5, '{"vitamin_c_mg":26}', 'seed'),
  ('183bf2e1-d18f-427c-aa28-791896ba68de', 'Grapes', 'grapes', '1 cup', 151, 69, 0.7, 18.1, 0.2, 0.9, NULL, 'seed'),
  ('99887add-6394-46b5-a3af-1c763726f35f', 'Watermelon', 'watermelon', '1 cup', 152, 30, 0.6, 7.6, 0.2, 0.4, NULL, 'seed'),
  ('d6ea7af0-fe38-46cd-9d6c-9036a6ab1d45', 'Pineapple', 'pineapple', '1 cup', 165, 50, 0.5, 13.1, 0.1, 1.4, '{"vitamin_c_mg":48}', 'seed'),
  ('f30b1c9f-c2b0-4f7e-aab9-efca57a2b257', 'Mango', 'mango', '1 cup', 165, 60, 0.8, 15, 0.4, 1.6, '{"vitamin_c_mg":36}', 'seed'),
  ('84d92767-80d6-4f01-bcc0-0823deb24436', 'Peach', 'peach', '1 medium', 150, 39, 0.9, 9.5, 0.3, 1.5, NULL, 'seed'),
  ('4f47450d-c383-4bc8-abf9-1d9fec477e86', 'Pear', 'pear', '1 medium', 178, 57, 0.4, 15.2, 0.1, 3.1, NULL, 'seed'),
  ('9ff4d2e6-6a73-4c49-8ae0-f8605910b164', 'Cherries', 'cherries', '1 cup', 154, 63, 1.1, 16, 0.2, 2.1, NULL, 'seed'),
  ('dee331c2-9886-443c-b39a-808aadd429d1', 'Avocado', 'avocado', '1/2 avocado', 68, 160, 2, 8.5, 14.7, 6.7, '{"potassium_mg":485,"folate_mcg":81}', 'seed'),
  ('714bb9a8-b032-4928-a274-bd9ae7dc5c64', 'Medjool date', 'medjool date', '1 date', 24, 277, 1.8, 75, 0.2, 6.7, '{"potassium_mg":696}', 'seed'),
  ('cacf96ff-9435-4582-8622-81d3a68447e9', 'Raisins', 'raisins', '1 small box', 43, 299, 3.1, 79.2, 0.5, 3.7, '{"potassium_mg":749}', 'seed');

-- --- Vegetables ----------------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('e24d3676-bdb8-418d-b11d-132ad3ea29d1', 'Broccoli, raw', 'broccoli, raw', '1 cup', 91, 34, 2.8, 6.6, 0.4, 2.6, '{"vitamin_c_mg":89,"folate_mcg":63}', 'seed'),
  ('7b258c06-13e8-48c3-84ab-66babe31728b', 'Broccoli, cooked', 'broccoli, cooked', '1 cup', 156, 35, 2.4, 7.2, 0.4, 3.3, '{"vitamin_c_mg":65}', 'seed'),
  ('1ac88b79-9548-4f69-a02f-a7b90099bc40', 'Spinach, raw', 'spinach, raw', '2 cups', 60, 23, 2.9, 3.6, 0.4, 2.2, '{"folate_mcg":194,"iron_mg":2.7,"magnesium_mg":79}', 'seed'),
  ('376c58f6-5512-4ad3-8b93-532143ec0433', 'Kale, raw', 'kale, raw', '2 cups', 42, 35, 2.9, 4.4, 1.5, 4.1, '{"vitamin_c_mg":93,"calcium_mg":254}', 'seed'),
  ('f7d12265-5d96-49fc-ba10-07ab894d9dfe', 'Romaine lettuce', 'romaine lettuce', '2 cups', 94, 17, 1.2, 3.3, 0.3, 2.1, '{"folate_mcg":136}', 'seed'),
  ('a308b688-f57c-46f0-8ed1-1c8d95993823', 'Carrot', 'carrot', '1 medium', 61, 41, 0.9, 9.6, 0.2, 2.8, NULL, 'seed'),
  ('33d5a2f4-a790-405a-acdb-0166e4c2e99b', 'Tomato', 'tomato', '1 medium', 123, 18, 0.9, 3.9, 0.2, 1.2, '{"potassium_mg":237}', 'seed'),
  ('f9bced21-13f3-4244-8840-425dacba3897', 'Cucumber, with peel', 'cucumber, with peel', '1 cup', 104, 15, 0.7, 3.6, 0.1, 0.5, NULL, 'seed'),
  ('e6597295-f92f-43c4-aa1e-e19b3c004004', 'Bell pepper, red', 'bell pepper, red', '1 medium', 119, 31, 1, 6, 0.3, 2.1, '{"vitamin_c_mg":128}', 'seed'),
  ('b225a7e0-f9e8-49c0-8824-5261e71a9d35', 'Onion', 'onion', '1 medium', 110, 40, 1.1, 9.3, 0.1, 1.7, NULL, 'seed'),
  ('823d70d1-20fd-40ff-a263-b3be5866d710', 'Garlic', 'garlic', '1 clove', 3, 149, 6.4, 33.1, 0.5, 2.1, NULL, 'seed'),
  ('1ea507cf-c75b-426f-a8e1-bd7384fe3732', 'Mushrooms, white', 'mushrooms, white', '1 cup', 70, 22, 3.1, 3.3, 0.3, 1, NULL, 'seed'),
  ('1183bb48-5efd-476b-afbb-b83c05c3d526', 'Zucchini', 'zucchini', '1 medium', 196, 17, 1.2, 3.1, 0.3, 1, NULL, 'seed'),
  ('173a15e4-f4e9-4855-b2c4-fca8845da88c', 'Cauliflower', 'cauliflower', '1 cup', 107, 25, 1.9, 5, 0.3, 2, '{"vitamin_c_mg":48}', 'seed'),
  ('f477e019-f6d6-45b6-a725-8cada195d1ca', 'Green beans', 'green beans', '1 cup', 100, 31, 1.8, 7, 0.2, 2.7, NULL, 'seed'),
  ('467bd0c9-632b-4367-a822-29dcbdd0194f', 'Asparagus', 'asparagus', '6 spears', 90, 20, 2.2, 3.9, 0.1, 2.1, '{"folate_mcg":52}', 'seed'),
  ('20edfcaf-7fc6-4b7b-9069-8bffb5d2b96d', 'Brussels sprouts', 'brussels sprouts', '1 cup', 88, 43, 3.4, 9, 0.3, 3.8, '{"vitamin_c_mg":85}', 'seed'),
  ('7512d916-967a-48bd-b464-3404b03549e1', 'Cabbage', 'cabbage', '1 cup', 89, 25, 1.3, 5.8, 0.1, 2.5, NULL, 'seed'),
  ('2670a092-9ac2-41e1-82db-b43b38a6707a', 'Celery', 'celery', '1 stalk', 40, 14, 0.7, 3, 0.2, 1.6, NULL, 'seed'),
  ('9ac2f9e7-5102-4ab9-bea1-5dfff0f655b1', 'Beets, cooked', 'beets, cooked', '1 cup', 170, 44, 1.7, 10, 0.2, 2, '{"potassium_mg":305,"folate_mcg":80}', 'seed'),
  ('c4c5e6b7-0b3d-4512-9a23-39da7fd8b2c8', 'Corn, sweet, cooked', 'corn, sweet, cooked', '1 ear', 103, 96, 3.4, 21, 1.5, 2.4, NULL, 'seed'),
  ('d53d3587-9a34-4701-9aad-fc0fcc4069cd', 'Green peas, cooked', 'green peas, cooked', '1 cup', 160, 84, 5.4, 15.6, 0.2, 5.5, NULL, 'seed'),
  ('7989c89b-c43f-4045-b62a-19d0047cbcb2', 'Butternut squash, cooked', 'butternut squash, cooked', '1 cup', 205, 40, 0.9, 10.5, 0.1, 3.2, '{"potassium_mg":284}', 'seed'),
  ('6f93f18e-6bb4-449b-8982-aec49625f6d9', 'Sauerkraut', 'sauerkraut', '1/2 cup', 71, 19, 0.9, 4.3, 0.1, 2.9, '{"sodium_mg":661}', 'seed'),
  ('4b596f80-6676-4291-9c96-6428435ff883', 'Kimchi', 'kimchi', '1/2 cup', 75, 15, 1.1, 2.4, 0.5, 1.6, '{"sodium_mg":498}', 'seed'),
  ('d37e8ce1-c4f7-42a7-bb4b-391170e762fa', 'Olives', 'olives', '10 olives', 32, 115, 0.8, 6.3, 10.7, 3.2, '{"sodium_mg":735}', 'seed'),
  ('e586b728-5a30-417f-8570-40e41a4c5a41', 'Dill pickles', 'dill pickles', '1 spear', 35, 11, 0.3, 2.3, 0.2, 1.2, '{"sodium_mg":1208}', 'seed');

-- --- Fats, nuts & seeds --------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('27ef942e-bb16-41e2-81c4-a99d921967eb', 'Olive oil', 'olive oil', '1 tbsp', 14, 884, 0, 0, 100, 0, NULL, 'seed'),
  ('d075c37b-e38f-4dee-9fe0-c689436fd337', 'Avocado oil', 'avocado oil', '1 tbsp', 14, 884, 0, 0, 100, 0, NULL, 'seed'),
  ('dfe66530-d499-4e6b-b62f-71c1e89965f8', 'Coconut oil', 'coconut oil', '1 tbsp', 14, 892, 0, 0, 99.1, 0, NULL, 'seed'),
  ('2542aa3d-47f7-4520-a231-4ea810d335e1', 'Butter, salted', 'butter, salted', '1 tbsp', 14, 717, 0.9, 0.1, 81.1, 0, '{"sodium_mg":643}', 'seed'),
  ('d013386e-93e8-4122-b8a4-fbed383449d2', 'Mayonnaise', 'mayonnaise', '1 tbsp', 13, 680, 1, 0.6, 75, 0, '{"sodium_mg":635}', 'seed'),
  ('901659fa-4b8f-41f0-9f26-4b7304340fd6', 'Almonds', 'almonds', '1 oz (23)', 28, 579, 21.2, 21.6, 49.9, 12.5, '{"magnesium_mg":270,"calcium_mg":269}', 'seed'),
  ('346f8a99-9b37-45bc-8c72-0bec9f5e1190', 'Walnuts', 'walnuts', '1 oz', 28, 654, 15.2, 13.7, 65.2, 6.7, '{"omega3_g":9.1}', 'seed'),
  ('e010db26-6032-4536-9747-9328ddbd94bc', 'Cashews', 'cashews', '1 oz', 28, 553, 18.2, 30.2, 43.8, 3.3, '{"magnesium_mg":292,"zinc_mg":5.8}', 'seed'),
  ('e78dc449-6c8a-45c3-b66b-cea1c2d68c4c', 'Pistachios', 'pistachios', '1 oz (49)', 28, 560, 20.2, 27.2, 45.3, 10.6, NULL, 'seed'),
  ('8f0a8963-00d5-46ca-96bc-15373139b5fb', 'Peanuts', 'peanuts', '1 oz', 28, 567, 25.8, 16.1, 49.2, 8.5, '{"magnesium_mg":168}', 'seed'),
  ('bdb4cd68-0e6d-4190-baf9-7d7453af8d34', 'Peanut butter', 'peanut butter', '2 tbsp', 32, 588, 25.1, 19.6, 50, 6, '{"sodium_mg":426}', 'seed'),
  ('28a20b9f-5638-4cda-9f98-8854d505e4a9', 'Almond butter', 'almond butter', '2 tbsp', 32, 614, 21, 18.8, 55.5, 10.3, '{"magnesium_mg":279}', 'seed'),
  ('c30c43c9-6244-4e83-a5d0-c7737f677d6a', 'Chia seeds', 'chia seeds', '1 tbsp', 12, 486, 16.5, 42.1, 30.7, 34.4, '{"omega3_g":17.8,"calcium_mg":631,"magnesium_mg":335}', 'seed'),
  ('2dbe577f-6a0b-44ff-9111-3e14f1cd0fdb', 'Flaxseed, ground', 'flaxseed, ground', '1 tbsp', 7, 534, 18.3, 28.9, 42.2, 27.3, '{"omega3_g":22.8,"magnesium_mg":392}', 'seed'),
  ('42e54c75-43ca-4adb-a1f5-65b82342e369', 'Pumpkin seeds', 'pumpkin seeds', '1 oz', 28, 559, 30.2, 10.7, 49, 6, '{"magnesium_mg":592,"zinc_mg":7.8,"iron_mg":8.8}', 'seed'),
  ('3ed57aa6-8ba2-4314-9e2d-ee15f07e6647', 'Hemp seeds', 'hemp seeds', '3 tbsp', 30, 553, 31.6, 8.7, 48.8, 4, '{"magnesium_mg":700}', 'seed'),
  ('8ec296da-6053-4ccd-8fbb-a94fedc0ef08', 'Dark chocolate, 70-85%', 'dark chocolate, 70-85%', '1 square', 10, 598, 7.8, 45.9, 42.6, 10.9, '{"iron_mg":11.9,"magnesium_mg":228}', 'seed'),
  ('0cf7bd11-58bb-4105-a346-f095009e613e', 'Milk chocolate', 'milk chocolate', '1 bar', 44, 535, 7.7, 59.4, 29.7, 3.4, NULL, 'seed');

-- --- Meals & restaurant archetypes ---------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('0ebe9341-dc6f-498c-bfb5-b5b3e1df78eb', 'Pizza, cheese slice', 'pizza, cheese slice', '1 slice', 107, 266, 11, 33, 9.7, 2.3, '{"sodium_mg":598}', 'seed'),
  ('358d0793-515f-465e-a63e-f5ee1fc5bd35', 'Cheeseburger, fast food', 'cheeseburger, fast food', '1 burger', 115, 263, 12.9, 28.6, 11.2, 1.5, '{"sodium_mg":590}', 'seed'),
  ('a067b123-d9d8-4185-9f6a-d421b50a1dbc', 'Chicken burrito', 'chicken burrito', '1 burrito', 450, 180, 10, 21, 6.5, 2.5, '{"sodium_mg":470}', 'seed'),
  ('b8eaf40a-356f-4e76-8a99-90b930af87d6', 'California sushi roll', 'california sushi roll', '1 roll (8 pc)', 220, 130, 5, 24, 2, 1, '{"sodium_mg":335}', 'seed'),
  ('62acbc6c-be96-4d79-aeb4-cd743a7a237c', 'Caesar salad with chicken', 'caesar salad with chicken', '1 bowl', 350, 127, 9.7, 4.9, 7.6, 1.4, '{"sodium_mg":390}', 'seed'),
  ('41a886c1-5092-48dc-ab3c-e8e517ee135e', 'Chicken and rice bowl', 'chicken and rice bowl', '1 bowl', 450, 140, 10.5, 17, 3.4, 1.2, NULL, 'seed'),
  ('78c512ee-97f2-48d2-967f-b11820121357', 'Beef taco, hard shell', 'beef taco, hard shell', '1 taco', 78, 218, 12.9, 20.3, 10.4, 3, '{"sodium_mg":456}', 'seed'),
  ('e7955999-7f51-41c7-afed-f96c26ef687a', 'Ham sandwich', 'ham sandwich', '1 sandwich', 150, 235, 12, 26, 9, 1.7, '{"sodium_mg":850}', 'seed'),
  ('c5a73d6e-f0b5-44bf-90d4-6ded36f3c525', 'Peanut butter and jelly sandwich', 'peanut butter and jelly sandwich', '1 sandwich', 100, 378, 12, 42, 18, 3.4, NULL, 'seed'),
  ('98f92c79-34f1-4e8e-b804-8d3870e9d3f1', 'French fries', 'french fries', '1 medium serving', 117, 312, 3.4, 41.4, 15, 3.8, '{"sodium_mg":210}', 'seed'),
  ('40e1029e-9108-4e2d-8a1d-7c2c82966cc8', 'Fried chicken, breaded', 'fried chicken, breaded', '1 piece', 140, 246, 23.2, 8.5, 13.3, 0.4, '{"sodium_mg":490}', 'seed'),
  ('5d41b2ba-9bf9-447d-9026-a541ebf70006', 'Macaroni and cheese', 'macaroni and cheese', '1 cup', 200, 164, 6.4, 20.1, 6.6, 1.3, '{"sodium_mg":380}', 'seed'),
  ('cb1ee492-71e7-40a1-89b3-95e87da0897f', 'Spaghetti with meat sauce', 'spaghetti with meat sauce', '1 plate', 400, 130, 6.8, 16.4, 4.2, 2, '{"sodium_mg":310}', 'seed'),
  ('94f13354-1592-481d-99a4-8d3895f1968b', 'Fried rice, takeout', 'fried rice, takeout', '1 cup', 198, 163, 6, 20, 6.2, 1, '{"sodium_mg":460}', 'seed'),
  ('f8920862-e004-416f-98d7-0bcdd49c3755', 'Chicken noodle soup', 'chicken noodle soup', '1 cup', 245, 36, 2.5, 3.5, 1.2, 0.3, '{"sodium_mg":343}', 'seed'),
  ('369eee24-7ce4-4b93-80d6-aeb2413cb51d', 'Miso soup', 'miso soup', '1 bowl', 240, 17, 1.5, 2.1, 0.5, 0.4, '{"sodium_mg":380}', 'seed'),
  ('89cd94a5-2feb-4d98-8dad-78bf2c038632', 'Turkey chili', 'turkey chili', '1 cup', 250, 105, 8, 9, 4, 2.5, '{"sodium_mg":350}', 'seed'),
  ('099d8bfb-93c2-449f-9982-0dfe4699adbc', 'Bone broth', 'bone broth', '1 cup', 240, 15, 3.5, 0.5, 0.2, 0, '{"sodium_mg":250}', 'seed'),
  ('6b383279-970f-4bdd-b593-9fa8652f925c', 'Protein bar', 'protein bar', '1 bar', 60, 380, 30, 42, 10, 5, NULL, 'seed'),
  ('eb4a108a-c2c3-473f-8828-e7686c619534', 'Protein shake, ready-to-drink', 'protein shake, ready-to-drink', '1 bottle', 340, 44, 7.6, 1.5, 0.7, 0, '{"calcium_mg":120}', 'seed');

-- --- Snacks & sweets -----------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('e2a4ac57-4855-406b-a17c-1b3d8d6a15c5', 'Hummus', 'hummus', '2 tbsp', 30, 166, 7.9, 14.3, 9.6, 6, '{"sodium_mg":379}', 'seed'),
  ('2a17bced-edb1-4941-8a8b-d5d67ffb05b3', 'Guacamole', 'guacamole', '2 tbsp', 30, 157, 2, 8.5, 14.3, 5.4, NULL, 'seed'),
  ('bd9d5e2d-2aea-4466-9633-ee73ce5b23ad', 'Salsa', 'salsa', '2 tbsp', 32, 36, 1.5, 7, 0.2, 1.4, '{"sodium_mg":430}', 'seed'),
  ('9974ad98-dc2e-420f-a7d8-082cd35cb1b1', 'Tortilla chips', 'tortilla chips', '1 oz', 28, 503, 7, 63, 23.4, 5.3, '{"sodium_mg":328}', 'seed'),
  ('9dac8c85-bd17-4980-8b06-c1cb5078dc22', 'Potato chips', 'potato chips', '1 oz', 28, 536, 7, 52.9, 34.6, 4.8, '{"sodium_mg":525}', 'seed'),
  ('90c010f8-cfde-42b5-8477-7486b456daf6', 'Pretzels', 'pretzels', '1 oz', 28, 380, 10, 80, 3, 3, '{"sodium_mg":1240}', 'seed'),
  ('09444656-fb8a-424d-b83c-65128d5cae58', 'Trail mix', 'trail mix', '1/4 cup', 37, 462, 13.8, 44.9, 29.4, 4, NULL, 'seed'),
  ('f13087c8-c209-4b1a-a7dd-4e325975a447', 'Chocolate chip cookie', 'chocolate chip cookie', '1 cookie', 30, 488, 5.7, 63.9, 24.3, 2.4, NULL, 'seed'),
  ('4b892eb6-e9aa-490e-ae97-1ab2694306b6', 'Oatmeal cookie', 'oatmeal cookie', '1 cookie', 30, 450, 6, 68, 16, 2.8, NULL, 'seed'),
  ('6ba31373-9b8a-49be-80e1-4d91adfc3536', 'Croissant', 'croissant', '1 croissant', 57, 406, 8.2, 45.8, 21, 2.6, NULL, 'seed'),
  ('eafe9b90-721d-4763-a65b-9be3d9ed73fd', 'Blueberry muffin', 'blueberry muffin', '1 muffin', 113, 377, 6.5, 54.2, 15.7, 1.5, NULL, 'seed'),
  ('ac6c6161-5b04-49d0-a554-67b9960237e3', 'Banana bread', 'banana bread', '1 slice', 60, 326, 4.3, 54.6, 10.5, 1.1, NULL, 'seed'),
  ('fa519e23-8023-4534-a3d2-7418c9e209e4', 'Pancakes', 'pancakes', '2 pancakes', 76, 227, 6.4, 28.3, 9.7, 1.9, NULL, 'seed');

-- --- Condiments & sweeteners ---------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('90e41ba4-fcf1-4f65-975c-a13008123446', 'Ketchup', 'ketchup', '1 tbsp', 17, 101, 1.3, 27.4, 0.1, 0.3, '{"sodium_mg":907}', 'seed'),
  ('8592c664-4346-4123-a2bb-f33388afa3a7', 'Yellow mustard', 'yellow mustard', '1 tsp', 5, 60, 3.7, 5.8, 3.3, 3.3, '{"sodium_mg":1104}', 'seed'),
  ('ace6b2be-ad54-49de-a902-4b9d3f2dc4e8', 'Ranch dressing', 'ranch dressing', '2 tbsp', 30, 430, 1.3, 5.9, 44.5, 0, '{"sodium_mg":901}', 'seed'),
  ('852a7f71-bac9-41eb-b98c-9c4b0ceb7409', 'Balsamic vinaigrette', 'balsamic vinaigrette', '2 tbsp', 30, 299, 0.3, 16.6, 25, 0, '{"sodium_mg":630}', 'seed'),
  ('c8d7fc9b-484b-49e9-a41b-9e538c29e16b', 'Soy sauce', 'soy sauce', '1 tbsp', 16, 53, 8.1, 4.9, 0.6, 0.8, '{"sodium_mg":5493}', 'seed'),
  ('ff61090d-c48a-485a-8e48-062584fc16de', 'Sriracha', 'sriracha', '1 tsp', 7, 93, 2, 19, 1, 2.2, '{"sodium_mg":2124}', 'seed'),
  ('5a02ac40-0332-4a2b-b85c-d8519d5716f2', 'Barbecue sauce', 'barbecue sauce', '2 tbsp', 36, 172, 0.8, 40.8, 0.6, 0.9, '{"sodium_mg":1027}', 'seed'),
  ('4bcf19c9-4d1a-4cc6-a3b4-d9586c3d5037', 'Honey', 'honey', '1 tbsp', 21, 304, 0.3, 82.4, 0, 0.2, NULL, 'seed'),
  ('63ae4371-a8c7-4c94-b2af-adf21990b99c', 'Maple syrup', 'maple syrup', '1 tbsp', 20, 260, 0, 67, 0.1, 0, NULL, 'seed'),
  ('7f6c3cde-9e35-4a03-8a87-810bce7c2332', 'White sugar', 'white sugar', '1 tsp', 4, 387, 0, 100, 0, 0, NULL, 'seed');

-- --- Beverages -----------------------------------------------------------------
INSERT INTO foods
  (id, name, name_norm, serving_name, serving_grams, kcal_100g, protein_g_100g, carbs_g_100g, fat_g_100g, fiber_g_100g, micros, source)
VALUES
  ('3ba0c51e-4cae-4e30-835d-213a998b0b9d', 'Orange juice', 'orange juice', '1 cup', 248, 45, 0.7, 10.4, 0.2, 0.2, '{"vitamin_c_mg":50,"potassium_mg":200}', 'seed'),
  ('a3906843-bed5-44c4-b853-cf9203163e23', 'Apple juice', 'apple juice', '1 cup', 248, 46, 0.1, 11.3, 0.1, 0.2, NULL, 'seed'),
  ('c458157a-1d0c-42b4-833c-d36cc8ef994c', 'Cola', 'cola', '1 can (12 oz)', 355, 42, 0, 10.6, 0, 0, NULL, 'seed'),
  ('97d848fc-3970-4d1f-8245-d9ed9c60db2d', 'Sports drink', 'sports drink', '1 bottle (20 oz)', 591, 26, 0, 6.4, 0, 0, '{"sodium_mg":41}', 'seed'),
  ('b26ed83b-5692-4163-9134-a1a45b952b22', 'Kombucha', 'kombucha', '1 bottle (16 oz)', 480, 13, 0, 3.3, 0, 0, NULL, 'seed'),
  ('dadc2081-5f87-4e4f-b3cc-fcd3a076727a', 'Beer', 'beer', '1 can (12 oz)', 355, 43, 0.5, 3.6, 0, 0, NULL, 'seed'),
  ('d2db1af7-5840-463b-afb5-501814c8764c', 'Red wine', 'red wine', '1 glass (5 oz)', 147, 85, 0.1, 2.6, 0, 0, NULL, 'seed'),
  ('5a85592e-47b6-40d4-a644-befebf5e07cc', 'White wine', 'white wine', '1 glass (5 oz)', 147, 82, 0.1, 2.6, 0, 0, NULL, 'seed'),
  ('6cbfa342-4429-4f67-b53e-c8c47411bd12', 'Whiskey', 'whiskey', '1 shot (1.5 oz)', 42, 250, 0, 0, 0, 0, NULL, 'seed'),
  ('a1cef987-d928-48db-a726-e9b98b742263', 'Coffee, black', 'coffee, black', '1 cup', 240, 1, 0.1, 0, 0, 0, NULL, 'seed'),
  ('bb7b36af-e57e-44fd-9062-37a158612e02', 'Latte, whole milk', 'latte, whole milk', '12 oz', 340, 44, 2.3, 3.5, 2.4, 0, '{"calcium_mg":80}', 'seed');
