-- YesGATC parity: ensure products.capacities.specifications[] exists when
-- legacy top-level Max/e/Min/d/MPE/n fields are present without a specs array.

UPDATE products
SET capacities = jsonb_set(
  capacities,
  '{specifications}',
  jsonb_build_array(
    jsonb_strip_nulls(
      jsonb_build_object(
        'id', 'primary',
        'maximumCapacity', CASE
          WHEN capacities ? 'maximumCapacity'
            AND NULLIF(TRIM(capacities->>'maximumCapacity'), '') IS NOT NULL
            AND (capacities->>'maximumCapacity') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (capacities->>'maximumCapacity')::numeric
          ELSE NULL
        END,
        'verificationScaleInterval', CASE
          WHEN capacities ? 'verificationScaleInterval'
            AND NULLIF(TRIM(capacities->>'verificationScaleInterval'), '') IS NOT NULL
            AND (capacities->>'verificationScaleInterval') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (capacities->>'verificationScaleInterval')::numeric
          ELSE NULL
        END,
        'maximumPermissibleError', CASE
          WHEN capacities ? 'maximumPermissibleError'
            AND NULLIF(TRIM(capacities->>'maximumPermissibleError'), '') IS NOT NULL
            AND (capacities->>'maximumPermissibleError') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (capacities->>'maximumPermissibleError')::numeric
          ELSE NULL
        END,
        'minimumCapacity', CASE
          WHEN capacities ? 'minimumCapacity'
            AND NULLIF(TRIM(capacities->>'minimumCapacity'), '') IS NOT NULL
            AND (capacities->>'minimumCapacity') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (capacities->>'minimumCapacity')::numeric
          ELSE NULL
        END,
        'actualScaleInterval', CASE
          WHEN capacities ? 'actualScaleInterval'
            AND NULLIF(TRIM(capacities->>'actualScaleInterval'), '') IS NOT NULL
            AND (capacities->>'actualScaleInterval') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (capacities->>'actualScaleInterval')::numeric
          ELSE NULL
        END,
        'noOfVerificationIntervals', CASE
          WHEN capacities ? 'noOfVerificationIntervals'
            AND NULLIF(TRIM(capacities->>'noOfVerificationIntervals'), '') IS NOT NULL
            AND (capacities->>'noOfVerificationIntervals') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          THEN (capacities->>'noOfVerificationIntervals')::numeric
          ELSE NULL
        END
      )
    )
  ),
  true
)
WHERE COALESCE(jsonb_typeof(capacities->'specifications'), 'null') <> 'array'
  AND (
    capacities ? 'maximumCapacity'
    OR capacities ? 'verificationScaleInterval'
  );

-- Drop empty primary stubs produced when legacy numbers were absent.
UPDATE products
SET capacities = capacities - 'specifications'
WHERE jsonb_typeof(capacities->'specifications') = 'array'
  AND jsonb_array_length(capacities->'specifications') = 1
  AND (
    capacities->'specifications'->0->>'maximumCapacity' IS NULL
    OR capacities->'specifications'->0->>'verificationScaleInterval' IS NULL
  );
