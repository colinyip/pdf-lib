/* @flow */
import _ from 'lodash';
import pako from 'pako';
import fontkit from 'fontkit';

import PDFDocument from 'core/pdf-document/PDFDocument';
import {
  PDFDictionary,
  PDFRawStream,
  PDFNumber,
  PDFName,
  PDFArray,
  PDFIndirectReference,
} from 'core/pdf-objects';
import { setCharAt } from 'utils';
import { validate, isInstance } from 'utils/validate';

import type { PDFObjectLookup } from 'core/pdf-document/PDFObjectIndex';

const { Buffer } = require('buffer/');

const unsigned32Bit = '00000000000000000000000000000000';

export type FontFlagOptions = {
  FixedPitch?: boolean,
  Serif?: boolean,
  Symbolic?: boolean,
  Script?: boolean,
  Nonsymbolic?: boolean,
  Italic?: boolean,
  AllCap?: boolean,
  SmallCap?: boolean,
  ForceBold?: boolean,
};

/* eslint-disable prettier/prettier */
/*
Doing this by bit-twiddling a string, and then parsing it, gets around
JavaScript converting the results of bit-shifting ops back into 64-bit integers.
*/
const fontFlags = (options: FontFlagOptions) => {
  let flags = unsigned32Bit;
  if (options.FixedPitch)  flags = setCharAt(flags, 32 - 1, '1');
  if (options.Serif)       flags = setCharAt(flags, 32 - 2, '1');
  if (options.Symbolic)    flags = setCharAt(flags, 32 - 3, '1');
  if (options.Script)      flags = setCharAt(flags, 32 - 4, '1');
  if (options.Nonsymbolic) flags = setCharAt(flags, 32 - 6, '1');
  if (options.Italic)      flags = setCharAt(flags, 32 - 7, '1');
  if (options.AllCap)      flags = setCharAt(flags, 32 - 17, '1');
  if (options.SmallCap)    flags = setCharAt(flags, 32 - 18, '1');
  if (options.ForceBold)   flags = setCharAt(flags, 32 - 19, '1');
  return parseInt(flags, 2);
};
/* eslint-enable prettier/prettier */

/**
This Factory supports TrueType and OpenType fonts. Note that the apparent
hardcoding of values for OpenType fonts does not actually affect TrueType fonts.

A note of thanks to the developers of https://github.com/devongovett/pdfkit, as
this class borrows heavily from:
https://github.com/devongovett/pdfkit/blob/e71edab0dd4657b5a767804ba86c94c58d01fbca/lib/font/embedded.coffee
*/
class PDFFontFactory {
  font: any;
  scale: number;
  fontName: string;
  fontData: Uint8Array;
  flagOptions: FontFlagOptions;

  constructor(
    name: string,
    fontData: Uint8Array,
    flagOptions: FontFlagOptions,
  ) {
    validate(name, _.isString, '"name" must be a string');
    validate(
      fontData,
      isInstance(Uint8Array),
      '"fontData" must be a Uint8Array',
    );
    validate(flagOptions, _.isObject, '"flagOptions" must be an Object');

    // This has to work in browser & Node JS environments. And, unfortunately,
    // the "fontkit" package makes use of Node "Buffer" objects, instead of
    // standard JS typed arrays. So, for now we'll just use the "buffer" package
    // to convert the "data" to a "Buffer" object that "fontkit" can work with.
    const dataBuffer = Buffer.from(fontData);

    this.fontName = name;
    this.fontData = fontData;
    this.flagOptions = flagOptions;
    this.font = fontkit.create(dataBuffer);
    this.scale = 1000 / this.font.unitsPerEm;
  }

  static for = (
    name: string,
    fontData: Uint8Array,
    flagOptions: FontFlagOptions,
  ) => new PDFFontFactory(name, fontData, flagOptions);

  /*
  TODO: This is hardcoded for "Simple Fonts" with non-modified encodings, need
  to broaden support to other fonts.
  */
  embedFontIn = (pdfDoc: PDFDocument): PDFIndirectReference<PDFDictionary> => {
    const fontStreamDict = PDFDictionary.from(
      {
        Subtype: PDFName.from('OpenType'),
        Filter: PDFName.from('FlateDecode'),
        Length: PDFNumber.fromNumber(this.fontData.length),
      },
      pdfDoc.index.lookup,
    );
    const fontStream = pdfDoc.register(
      PDFRawStream.from(fontStreamDict, pako.deflate(this.fontData)),
    );

    const {
      italicAngle,
      ascent,
      descent,
      capHeight,
      xHeight,
      bbox,
    } = this.font;

    const fontDescriptor = PDFDictionary.from(
      {
        Type: PDFName.from('FontDescriptor'),
        FontName: PDFName.from(this.fontName),
        Flags: PDFNumber.fromNumber(fontFlags(this.flagOptions)),
        FontBBox: PDFArray.fromArray(
          [
            PDFNumber.fromNumber(bbox.minX * this.scale),
            PDFNumber.fromNumber(bbox.minY * this.scale),
            PDFNumber.fromNumber(bbox.maxX * this.scale),
            PDFNumber.fromNumber(bbox.maxY * this.scale),
          ],
          pdfDoc.index.lookup,
        ),
        ItalicAngle: PDFNumber.fromNumber(italicAngle),
        Ascent: PDFNumber.fromNumber(ascent * this.scale),
        Descent: PDFNumber.fromNumber(descent * this.scale),
        CapHeight: PDFNumber.fromNumber((capHeight || ascent) * this.scale),
        XHeight: PDFNumber.fromNumber((xHeight || 0) * this.scale),
        // Not sure how to compute/find this, nor is anybody else really:
        // https://stackoverflow.com/questions/35485179/stemv-value-of-the-truetype-font
        StemV: PDFNumber.fromNumber(0),
        FontFile3: fontStream,
      },
      pdfDoc.index.lookup,
    );

    return pdfDoc.register(
      PDFDictionary.from(
        {
          Type: PDFName.from('Font'),
          Subtype: PDFName.from('OpenType'),
          BaseFont: PDFName.from(this.fontName),
          FirstChar: PDFNumber.fromNumber(0),
          LastChar: PDFNumber.fromNumber(255),
          Widths: this.getWidths(pdfDoc.index.lookup),
          FontDescriptor: pdfDoc.register(fontDescriptor),
        },
        pdfDoc.index.lookup,
      ),
    );
  };

  getWidths = (lookup: PDFObjectLookup) =>
    PDFArray.fromArray(
      _.range(0, 256)
        .map(this.getCodePointWidth)
        .map(PDFNumber.fromNumber),
      lookup,
    );

  getCodePointWidth = (code: number) =>
    this.font.characterSet.includes(code)
      ? this.font.glyphForCodePoint(code).advanceWidth * this.scale
      : 0;
}

export default PDFFontFactory;
