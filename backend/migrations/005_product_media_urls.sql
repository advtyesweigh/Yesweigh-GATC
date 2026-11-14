-- Product catalogue media: store Firebase (or other) download URLs alongside storage paths.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS approval_doc_url TEXT;

CREATE INDEX IF NOT EXISTS products_image_url_idx
  ON products (image_url)
  WHERE image_url IS NOT NULL;
