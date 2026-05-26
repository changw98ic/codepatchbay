import { defineProperties } from '@vanilla-extract/sprinkles';
import { space, radius, fontSize, fontWeight } from './tokens';

const responsiveProperties = defineProperties({
  conditions: {
    mobile: {},
    tablet: { '@media': '(min-width: 768px)' },
    desktop: { '@media': '(min-width: 1024px)' },
  },
  defaultCondition: 'mobile',
  properties: {
    padding: space,
    margin: space,
    gap: space,
    borderRadius: radius,
    fontSize: fontSize,
    fontWeight: fontWeight,
  },
  shorthands: {
    p: ['padding'],
    m: ['margin'],
    gap: ['gap'],
    rounded: ['borderRadius'],
    text: ['fontSize'],
    weight: ['fontWeight'],
  },
});

export { responsiveProperties };
