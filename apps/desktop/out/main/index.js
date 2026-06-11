"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const node_path = require("node:path");
const fflate = require("fflate");
const node_sqlite = require("node:sqlite");
const node_crypto = require("node:crypto");
const node_fs = require("node:fs");
const chokidar = require("chokidar");
const node_os = require("node:os");
function blockText(block) {
  if (block.type === "paragraph")
    return block.text;
  return block.rows.map((row) => row.join(" | ")).join("\n");
}
function canonicalJson(model) {
  return JSON.stringify(model);
}
var validator = {};
var util = {};
var hasRequiredUtil;
function requireUtil() {
  if (hasRequiredUtil) return util;
  hasRequiredUtil = 1;
  (function(exports) {
    const nameStartChar = ":A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
    const nameChar = nameStartChar + "\\-.\\d\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
    const nameRegexp = "[" + nameStartChar + "][" + nameChar + "]*";
    const regexName = new RegExp("^" + nameRegexp + "$");
    const getAllMatches = function(string, regex) {
      const matches = [];
      let match = regex.exec(string);
      while (match) {
        const allmatches = [];
        allmatches.startIndex = regex.lastIndex - match[0].length;
        const len = match.length;
        for (let index = 0; index < len; index++) {
          allmatches.push(match[index]);
        }
        matches.push(allmatches);
        match = regex.exec(string);
      }
      return matches;
    };
    const isName = function(string) {
      const match = regexName.exec(string);
      return !(match === null || typeof match === "undefined");
    };
    exports.isExist = function(v) {
      return typeof v !== "undefined";
    };
    exports.isEmptyObject = function(obj) {
      return Object.keys(obj).length === 0;
    };
    exports.merge = function(target, a, arrayMode) {
      if (a) {
        const keys = Object.keys(a);
        const len = keys.length;
        for (let i = 0; i < len; i++) {
          if (arrayMode === "strict") {
            target[keys[i]] = [a[keys[i]]];
          } else {
            target[keys[i]] = a[keys[i]];
          }
        }
      }
    };
    exports.getValue = function(v) {
      if (exports.isExist(v)) {
        return v;
      } else {
        return "";
      }
    };
    const DANGEROUS_PROPERTY_NAMES = [
      // '__proto__',
      // 'constructor',
      // 'prototype',
      "hasOwnProperty",
      "toString",
      "valueOf",
      "__defineGetter__",
      "__defineSetter__",
      "__lookupGetter__",
      "__lookupSetter__"
    ];
    const criticalProperties = ["__proto__", "constructor", "prototype"];
    exports.isName = isName;
    exports.getAllMatches = getAllMatches;
    exports.nameRegexp = nameRegexp;
    exports.DANGEROUS_PROPERTY_NAMES = DANGEROUS_PROPERTY_NAMES;
    exports.criticalProperties = criticalProperties;
  })(util);
  return util;
}
var hasRequiredValidator;
function requireValidator() {
  if (hasRequiredValidator) return validator;
  hasRequiredValidator = 1;
  const util2 = requireUtil();
  const defaultOptions = {
    allowBooleanAttributes: false,
    //A tag can have attributes without any value
    unpairedTags: []
  };
  validator.validate = function(xmlData, options) {
    options = Object.assign({}, defaultOptions, options);
    const tags = [];
    let tagFound = false;
    let reachedRoot = false;
    if (xmlData[0] === "\uFEFF") {
      xmlData = xmlData.substr(1);
    }
    for (let i = 0; i < xmlData.length; i++) {
      if (xmlData[i] === "<" && xmlData[i + 1] === "?") {
        i += 2;
        i = readPI(xmlData, i);
        if (i.err) return i;
      } else if (xmlData[i] === "<") {
        let tagStartPos = i;
        i++;
        if (xmlData[i] === "!") {
          i = readCommentAndCDATA(xmlData, i);
          continue;
        } else {
          let closingTag = false;
          if (xmlData[i] === "/") {
            closingTag = true;
            i++;
          }
          let tagName = "";
          for (; i < xmlData.length && xmlData[i] !== ">" && xmlData[i] !== " " && xmlData[i] !== "	" && xmlData[i] !== "\n" && xmlData[i] !== "\r"; i++) {
            tagName += xmlData[i];
          }
          tagName = tagName.trim();
          if (tagName[tagName.length - 1] === "/") {
            tagName = tagName.substring(0, tagName.length - 1);
            i--;
          }
          if (!validateTagName(tagName)) {
            let msg;
            if (tagName.trim().length === 0) {
              msg = "Invalid space after '<'.";
            } else {
              msg = "Tag '" + tagName + "' is an invalid name.";
            }
            return getErrorObject("InvalidTag", msg, getLineNumberForPosition(xmlData, i));
          }
          const result = readAttributeStr(xmlData, i);
          if (result === false) {
            return getErrorObject("InvalidAttr", "Attributes for '" + tagName + "' have open quote.", getLineNumberForPosition(xmlData, i));
          }
          let attrStr = result.value;
          i = result.index;
          if (attrStr[attrStr.length - 1] === "/") {
            const attrStrStart = i - attrStr.length;
            attrStr = attrStr.substring(0, attrStr.length - 1);
            const isValid = validateAttributeString(attrStr, options);
            if (isValid === true) {
              tagFound = true;
            } else {
              return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, attrStrStart + isValid.err.line));
            }
          } else if (closingTag) {
            if (!result.tagClosed) {
              return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' doesn't have proper closing.", getLineNumberForPosition(xmlData, i));
            } else if (attrStr.trim().length > 0) {
              return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' can't have attributes or invalid starting.", getLineNumberForPosition(xmlData, tagStartPos));
            } else if (tags.length === 0) {
              return getErrorObject("InvalidTag", "Closing tag '" + tagName + "' has not been opened.", getLineNumberForPosition(xmlData, tagStartPos));
            } else {
              const otg = tags.pop();
              if (tagName !== otg.tagName) {
                let openPos = getLineNumberForPosition(xmlData, otg.tagStartPos);
                return getErrorObject(
                  "InvalidTag",
                  "Expected closing tag '" + otg.tagName + "' (opened in line " + openPos.line + ", col " + openPos.col + ") instead of closing tag '" + tagName + "'.",
                  getLineNumberForPosition(xmlData, tagStartPos)
                );
              }
              if (tags.length == 0) {
                reachedRoot = true;
              }
            }
          } else {
            const isValid = validateAttributeString(attrStr, options);
            if (isValid !== true) {
              return getErrorObject(isValid.err.code, isValid.err.msg, getLineNumberForPosition(xmlData, i - attrStr.length + isValid.err.line));
            }
            if (reachedRoot === true) {
              return getErrorObject("InvalidXml", "Multiple possible root nodes found.", getLineNumberForPosition(xmlData, i));
            } else if (options.unpairedTags.indexOf(tagName) !== -1) ;
            else {
              tags.push({ tagName, tagStartPos });
            }
            tagFound = true;
          }
          for (i++; i < xmlData.length; i++) {
            if (xmlData[i] === "<") {
              if (xmlData[i + 1] === "!") {
                i++;
                i = readCommentAndCDATA(xmlData, i);
                continue;
              } else if (xmlData[i + 1] === "?") {
                i = readPI(xmlData, ++i);
                if (i.err) return i;
              } else {
                break;
              }
            } else if (xmlData[i] === "&") {
              const afterAmp = validateAmpersand(xmlData, i);
              if (afterAmp == -1)
                return getErrorObject("InvalidChar", "char '&' is not expected.", getLineNumberForPosition(xmlData, i));
              i = afterAmp;
            } else {
              if (reachedRoot === true && !isWhiteSpace(xmlData[i])) {
                return getErrorObject("InvalidXml", "Extra text at the end", getLineNumberForPosition(xmlData, i));
              }
            }
          }
          if (xmlData[i] === "<") {
            i--;
          }
        }
      } else {
        if (isWhiteSpace(xmlData[i])) {
          continue;
        }
        return getErrorObject("InvalidChar", "char '" + xmlData[i] + "' is not expected.", getLineNumberForPosition(xmlData, i));
      }
    }
    if (!tagFound) {
      return getErrorObject("InvalidXml", "Start tag expected.", 1);
    } else if (tags.length == 1) {
      return getErrorObject("InvalidTag", "Unclosed tag '" + tags[0].tagName + "'.", getLineNumberForPosition(xmlData, tags[0].tagStartPos));
    } else if (tags.length > 0) {
      return getErrorObject("InvalidXml", "Invalid '" + JSON.stringify(tags.map((t) => t.tagName), null, 4).replace(/\r?\n/g, "") + "' found.", { line: 1, col: 1 });
    }
    return true;
  };
  function isWhiteSpace(char) {
    return char === " " || char === "	" || char === "\n" || char === "\r";
  }
  function readPI(xmlData, i) {
    const start = i;
    for (; i < xmlData.length; i++) {
      if (xmlData[i] == "?" || xmlData[i] == " ") {
        const tagname = xmlData.substr(start, i - start);
        if (i > 5 && tagname === "xml") {
          return getErrorObject("InvalidXml", "XML declaration allowed only at the start of the document.", getLineNumberForPosition(xmlData, i));
        } else if (xmlData[i] == "?" && xmlData[i + 1] == ">") {
          i++;
          break;
        } else {
          continue;
        }
      }
    }
    return i;
  }
  function readCommentAndCDATA(xmlData, i) {
    if (xmlData.length > i + 5 && xmlData[i + 1] === "-" && xmlData[i + 2] === "-") {
      for (i += 3; i < xmlData.length; i++) {
        if (xmlData[i] === "-" && xmlData[i + 1] === "-" && xmlData[i + 2] === ">") {
          i += 2;
          break;
        }
      }
    } else if (xmlData.length > i + 8 && xmlData[i + 1] === "D" && xmlData[i + 2] === "O" && xmlData[i + 3] === "C" && xmlData[i + 4] === "T" && xmlData[i + 5] === "Y" && xmlData[i + 6] === "P" && xmlData[i + 7] === "E") {
      let angleBracketsCount = 1;
      for (i += 8; i < xmlData.length; i++) {
        if (xmlData[i] === "<") {
          angleBracketsCount++;
        } else if (xmlData[i] === ">") {
          angleBracketsCount--;
          if (angleBracketsCount === 0) {
            break;
          }
        }
      }
    } else if (xmlData.length > i + 9 && xmlData[i + 1] === "[" && xmlData[i + 2] === "C" && xmlData[i + 3] === "D" && xmlData[i + 4] === "A" && xmlData[i + 5] === "T" && xmlData[i + 6] === "A" && xmlData[i + 7] === "[") {
      for (i += 8; i < xmlData.length; i++) {
        if (xmlData[i] === "]" && xmlData[i + 1] === "]" && xmlData[i + 2] === ">") {
          i += 2;
          break;
        }
      }
    }
    return i;
  }
  const doubleQuote = '"';
  const singleQuote = "'";
  function readAttributeStr(xmlData, i) {
    let attrStr = "";
    let startChar = "";
    let tagClosed = false;
    for (; i < xmlData.length; i++) {
      if (xmlData[i] === doubleQuote || xmlData[i] === singleQuote) {
        if (startChar === "") {
          startChar = xmlData[i];
        } else if (startChar !== xmlData[i]) ;
        else {
          startChar = "";
        }
      } else if (xmlData[i] === ">") {
        if (startChar === "") {
          tagClosed = true;
          break;
        }
      }
      attrStr += xmlData[i];
    }
    if (startChar !== "") {
      return false;
    }
    return {
      value: attrStr,
      index: i,
      tagClosed
    };
  }
  const validAttrStrRegxp = new RegExp(`(\\s*)([^\\s=]+)(\\s*=)?(\\s*(['"])(([\\s\\S])*?)\\5)?`, "g");
  function validateAttributeString(attrStr, options) {
    const matches = util2.getAllMatches(attrStr, validAttrStrRegxp);
    const attrNames = {};
    for (let i = 0; i < matches.length; i++) {
      if (matches[i][1].length === 0) {
        return getErrorObject("InvalidAttr", "Attribute '" + matches[i][2] + "' has no space in starting.", getPositionFromMatch(matches[i]));
      } else if (matches[i][3] !== void 0 && matches[i][4] === void 0) {
        return getErrorObject("InvalidAttr", "Attribute '" + matches[i][2] + "' is without value.", getPositionFromMatch(matches[i]));
      } else if (matches[i][3] === void 0 && !options.allowBooleanAttributes) {
        return getErrorObject("InvalidAttr", "boolean attribute '" + matches[i][2] + "' is not allowed.", getPositionFromMatch(matches[i]));
      }
      const attrName = matches[i][2];
      if (!validateAttrName(attrName)) {
        return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is an invalid name.", getPositionFromMatch(matches[i]));
      }
      if (!attrNames.hasOwnProperty(attrName)) {
        attrNames[attrName] = 1;
      } else {
        return getErrorObject("InvalidAttr", "Attribute '" + attrName + "' is repeated.", getPositionFromMatch(matches[i]));
      }
    }
    return true;
  }
  function validateNumberAmpersand(xmlData, i) {
    let re = /\d/;
    if (xmlData[i] === "x") {
      i++;
      re = /[\da-fA-F]/;
    }
    for (; i < xmlData.length; i++) {
      if (xmlData[i] === ";")
        return i;
      if (!xmlData[i].match(re))
        break;
    }
    return -1;
  }
  function validateAmpersand(xmlData, i) {
    i++;
    if (xmlData[i] === ";")
      return -1;
    if (xmlData[i] === "#") {
      i++;
      return validateNumberAmpersand(xmlData, i);
    }
    let count = 0;
    for (; i < xmlData.length; i++, count++) {
      if (xmlData[i].match(/\w/) && count < 20)
        continue;
      if (xmlData[i] === ";")
        break;
      return -1;
    }
    return i;
  }
  function getErrorObject(code, message, lineNumber) {
    return {
      err: {
        code,
        msg: message,
        line: lineNumber.line || lineNumber,
        col: lineNumber.col
      }
    };
  }
  function validateAttrName(attrName) {
    return util2.isName(attrName);
  }
  function validateTagName(tagname) {
    return util2.isName(tagname);
  }
  function getLineNumberForPosition(xmlData, index) {
    const lines = xmlData.substring(0, index).split(/\r?\n/);
    return {
      line: lines.length,
      // column number is last line's length + 1, because column numbering starts at 1:
      col: lines[lines.length - 1].length + 1
    };
  }
  function getPositionFromMatch(match) {
    return match.startIndex + match[1].length;
  }
  return validator;
}
var OptionsBuilder = {};
var hasRequiredOptionsBuilder;
function requireOptionsBuilder() {
  if (hasRequiredOptionsBuilder) return OptionsBuilder;
  hasRequiredOptionsBuilder = 1;
  const { DANGEROUS_PROPERTY_NAMES, criticalProperties } = requireUtil();
  const defaultOnDangerousProperty = (name) => {
    if (DANGEROUS_PROPERTY_NAMES.includes(name)) {
      return "__" + name;
    }
    return name;
  };
  const defaultOptions = {
    preserveOrder: false,
    attributeNamePrefix: "@_",
    attributesGroupName: false,
    textNodeName: "#text",
    ignoreAttributes: true,
    removeNSPrefix: false,
    // remove NS from tag name or attribute name if true
    allowBooleanAttributes: false,
    //a tag can have attributes without any value
    //ignoreRootElement : false,
    parseTagValue: true,
    parseAttributeValue: false,
    trimValues: true,
    //Trim string values of tag and attributes
    cdataPropName: false,
    numberParseOptions: {
      hex: true,
      leadingZeros: true,
      eNotation: true
    },
    tagValueProcessor: function(tagName, val) {
      return val;
    },
    attributeValueProcessor: function(attrName, val) {
      return val;
    },
    stopNodes: [],
    //nested tags will not be parsed even for errors
    alwaysCreateTextNode: false,
    isArray: () => false,
    commentPropName: false,
    unpairedTags: [],
    processEntities: true,
    htmlEntities: false,
    ignoreDeclaration: false,
    ignorePiTags: false,
    transformTagName: false,
    transformAttributeName: false,
    updateTag: function(tagName, jPath, attrs) {
      return tagName;
    },
    // skipEmptyListItem: false
    captureMetaData: false,
    maxNestedTags: 100,
    strictReservedNames: true,
    onDangerousProperty: defaultOnDangerousProperty
  };
  function validatePropertyName(propertyName, optionName) {
    if (typeof propertyName !== "string") {
      return;
    }
    const normalized = propertyName.toLowerCase();
    if (DANGEROUS_PROPERTY_NAMES.some((dangerous) => normalized === dangerous.toLowerCase())) {
      throw new Error(
        `[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`
      );
    }
    if (criticalProperties.some((dangerous) => normalized === dangerous.toLowerCase())) {
      throw new Error(
        `[SECURITY] Invalid ${optionName}: "${propertyName}" is a reserved JavaScript keyword that could cause prototype pollution`
      );
    }
  }
  function normalizeProcessEntities(value) {
    if (typeof value === "boolean") {
      return {
        enabled: value,
        // true or false
        maxEntitySize: 1e4,
        maxExpansionDepth: 10,
        maxTotalExpansions: 1e3,
        maxExpandedLength: 1e5,
        allowedTags: null,
        tagFilter: null
      };
    }
    if (typeof value === "object" && value !== null) {
      return {
        enabled: value.enabled !== false,
        maxEntitySize: Math.max(1, value.maxEntitySize ?? 1e4),
        maxExpansionDepth: Math.max(1, value.maxExpansionDepth ?? 1e4),
        maxTotalExpansions: Math.max(1, value.maxTotalExpansions ?? Infinity),
        maxExpandedLength: Math.max(1, value.maxExpandedLength ?? 1e5),
        maxEntityCount: Math.max(1, value.maxEntityCount ?? 1e3),
        allowedTags: value.allowedTags ?? null,
        tagFilter: value.tagFilter ?? null
      };
    }
    return normalizeProcessEntities(true);
  }
  const buildOptions = function(options) {
    const built = Object.assign({}, defaultOptions, options);
    const propertyNameOptions = [
      { value: built.attributeNamePrefix, name: "attributeNamePrefix" },
      { value: built.attributesGroupName, name: "attributesGroupName" },
      { value: built.textNodeName, name: "textNodeName" },
      { value: built.cdataPropName, name: "cdataPropName" },
      { value: built.commentPropName, name: "commentPropName" }
    ];
    for (const { value, name } of propertyNameOptions) {
      if (value) {
        validatePropertyName(value, name);
      }
    }
    if (built.onDangerousProperty === null) {
      built.onDangerousProperty = defaultOnDangerousProperty;
    }
    built.processEntities = normalizeProcessEntities(built.processEntities);
    return built;
  };
  OptionsBuilder.buildOptions = buildOptions;
  OptionsBuilder.defaultOptions = defaultOptions;
  return OptionsBuilder;
}
var xmlNode;
var hasRequiredXmlNode;
function requireXmlNode() {
  if (hasRequiredXmlNode) return xmlNode;
  hasRequiredXmlNode = 1;
  class XmlNode {
    constructor(tagname) {
      this.tagname = tagname;
      this.child = [];
      this[":@"] = {};
    }
    add(key, val) {
      if (key === "__proto__") key = "#__proto__";
      this.child.push({ [key]: val });
    }
    addChild(node) {
      if (node.tagname === "__proto__") node.tagname = "#__proto__";
      if (node[":@"] && Object.keys(node[":@"]).length > 0) {
        this.child.push({ [node.tagname]: node.child, [":@"]: node[":@"] });
      } else {
        this.child.push({ [node.tagname]: node.child });
      }
    }
  }
  xmlNode = XmlNode;
  return xmlNode;
}
var DocTypeReader_1;
var hasRequiredDocTypeReader;
function requireDocTypeReader() {
  if (hasRequiredDocTypeReader) return DocTypeReader_1;
  hasRequiredDocTypeReader = 1;
  const util2 = requireUtil();
  class DocTypeReader {
    constructor(options) {
      this.suppressValidationErr = !options;
      this.options = options || {};
    }
    readDocType(xmlData, i) {
      const entities = /* @__PURE__ */ Object.create(null);
      let entityCount = 0;
      if (xmlData[i + 3] === "O" && xmlData[i + 4] === "C" && xmlData[i + 5] === "T" && xmlData[i + 6] === "Y" && xmlData[i + 7] === "P" && xmlData[i + 8] === "E") {
        i = i + 9;
        let angleBracketsCount = 1;
        let hasBody = false, comment = false;
        let exp = "";
        for (; i < xmlData.length; i++) {
          if (xmlData[i] === "<" && !comment) {
            if (hasBody && hasSeq(xmlData, "!ENTITY", i)) {
              i += 7;
              let entityName, val;
              [entityName, val, i] = this.readEntityExp(xmlData, i + 1, this.suppressValidationErr);
              if (val.indexOf("&") === -1) {
                if (this.options.enabled !== false && this.options.maxEntityCount != null && entityCount >= this.options.maxEntityCount) {
                  throw new Error(
                    `Entity count (${entityCount + 1}) exceeds maximum allowed (${this.options.maxEntityCount})`
                  );
                }
                const escaped = entityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                entities[entityName] = {
                  regx: RegExp(`&${escaped};`, "g"),
                  val
                };
                entityCount++;
              }
            } else if (hasBody && hasSeq(xmlData, "!ELEMENT", i)) {
              i += 8;
              const { index } = this.readElementExp(xmlData, i + 1);
              i = index;
            } else if (hasBody && hasSeq(xmlData, "!ATTLIST", i)) {
              i += 8;
            } else if (hasBody && hasSeq(xmlData, "!NOTATION", i)) {
              i += 9;
              const { index } = this.readNotationExp(xmlData, i + 1, this.suppressValidationErr);
              i = index;
            } else if (hasSeq(xmlData, "!--", i)) {
              comment = true;
            } else {
              throw new Error(`Invalid DOCTYPE`);
            }
            angleBracketsCount++;
            exp = "";
          } else if (xmlData[i] === ">") {
            if (comment) {
              if (xmlData[i - 1] === "-" && xmlData[i - 2] === "-") {
                comment = false;
                angleBracketsCount--;
              }
            } else {
              angleBracketsCount--;
            }
            if (angleBracketsCount === 0) {
              break;
            }
          } else if (xmlData[i] === "[") {
            hasBody = true;
          } else {
            exp += xmlData[i];
          }
        }
        if (angleBracketsCount !== 0) {
          throw new Error(`Unclosed DOCTYPE`);
        }
      } else {
        throw new Error(`Invalid Tag instead of DOCTYPE`);
      }
      return { entities, i };
    }
    readEntityExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let entityName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i]) && xmlData[i] !== '"' && xmlData[i] !== "'") {
        entityName += xmlData[i];
        i++;
      }
      validateEntityName(entityName);
      i = skipWhitespace(xmlData, i);
      if (!this.suppressValidationErr) {
        if (xmlData.substring(i, i + 6).toUpperCase() === "SYSTEM") {
          throw new Error("External entities are not supported");
        } else if (xmlData[i] === "%") {
          throw new Error("Parameter entities are not supported");
        }
      }
      let entityValue = "";
      [i, entityValue] = this.readIdentifierVal(xmlData, i, "entity");
      if (this.options.enabled !== false && this.options.maxEntitySize != null && entityValue.length > this.options.maxEntitySize) {
        throw new Error(
          `Entity "${entityName}" size (${entityValue.length}) exceeds maximum allowed size (${this.options.maxEntitySize})`
        );
      }
      i--;
      return [entityName, entityValue, i];
    }
    readNotationExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let notationName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        notationName += xmlData[i];
        i++;
      }
      !this.suppressValidationErr && validateEntityName(notationName);
      i = skipWhitespace(xmlData, i);
      const identifierType = xmlData.substring(i, i + 6).toUpperCase();
      if (!this.suppressValidationErr && identifierType !== "SYSTEM" && identifierType !== "PUBLIC") {
        throw new Error(`Expected SYSTEM or PUBLIC, found "${identifierType}"`);
      }
      i += identifierType.length;
      i = skipWhitespace(xmlData, i);
      let publicIdentifier = null;
      let systemIdentifier = null;
      if (identifierType === "PUBLIC") {
        [i, publicIdentifier] = this.readIdentifierVal(xmlData, i, "publicIdentifier");
        i = skipWhitespace(xmlData, i);
        if (xmlData[i] === '"' || xmlData[i] === "'") {
          [i, systemIdentifier] = this.readIdentifierVal(xmlData, i, "systemIdentifier");
        }
      } else if (identifierType === "SYSTEM") {
        [i, systemIdentifier] = this.readIdentifierVal(xmlData, i, "systemIdentifier");
        if (!this.suppressValidationErr && !systemIdentifier) {
          throw new Error("Missing mandatory system identifier for SYSTEM notation");
        }
      }
      return { notationName, publicIdentifier, systemIdentifier, index: --i };
    }
    readIdentifierVal(xmlData, i, type) {
      let identifierVal = "";
      const startChar = xmlData[i];
      if (startChar !== '"' && startChar !== "'") {
        throw new Error(`Expected quoted string, found "${startChar}"`);
      }
      i++;
      while (i < xmlData.length && xmlData[i] !== startChar) {
        identifierVal += xmlData[i];
        i++;
      }
      if (xmlData[i] !== startChar) {
        throw new Error(`Unterminated ${type} value`);
      }
      i++;
      return [i, identifierVal];
    }
    readElementExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let elementName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        elementName += xmlData[i];
        i++;
      }
      if (!this.suppressValidationErr && !util2.isName(elementName)) {
        throw new Error(`Invalid element name: "${elementName}"`);
      }
      i = skipWhitespace(xmlData, i);
      let contentModel = "";
      if (xmlData[i] === "E" && hasSeq(xmlData, "MPTY", i)) {
        i += 4;
      } else if (xmlData[i] === "A" && hasSeq(xmlData, "NY", i)) {
        i += 2;
      } else if (xmlData[i] === "(") {
        i++;
        while (i < xmlData.length && xmlData[i] !== ")") {
          contentModel += xmlData[i];
          i++;
        }
        if (xmlData[i] !== ")") {
          throw new Error("Unterminated content model");
        }
      } else if (!this.suppressValidationErr) {
        throw new Error(`Invalid Element Expression, found "${xmlData[i]}"`);
      }
      return {
        elementName,
        contentModel: contentModel.trim(),
        index: i
      };
    }
    readAttlistExp(xmlData, i) {
      i = skipWhitespace(xmlData, i);
      let elementName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        elementName += xmlData[i];
        i++;
      }
      validateEntityName(elementName);
      i = skipWhitespace(xmlData, i);
      let attributeName = "";
      while (i < xmlData.length && !/\s/.test(xmlData[i])) {
        attributeName += xmlData[i];
        i++;
      }
      if (!validateEntityName(attributeName)) {
        throw new Error(`Invalid attribute name: "${attributeName}"`);
      }
      i = skipWhitespace(xmlData, i);
      let attributeType = "";
      if (xmlData.substring(i, i + 8).toUpperCase() === "NOTATION") {
        attributeType = "NOTATION";
        i += 8;
        i = skipWhitespace(xmlData, i);
        if (xmlData[i] !== "(") {
          throw new Error(`Expected '(', found "${xmlData[i]}"`);
        }
        i++;
        let allowedNotations = [];
        while (i < xmlData.length && xmlData[i] !== ")") {
          let notation = "";
          while (i < xmlData.length && xmlData[i] !== "|" && xmlData[i] !== ")") {
            notation += xmlData[i];
            i++;
          }
          notation = notation.trim();
          if (!validateEntityName(notation)) {
            throw new Error(`Invalid notation name: "${notation}"`);
          }
          allowedNotations.push(notation);
          if (xmlData[i] === "|") {
            i++;
            i = skipWhitespace(xmlData, i);
          }
        }
        if (xmlData[i] !== ")") {
          throw new Error("Unterminated list of notations");
        }
        i++;
        attributeType += " (" + allowedNotations.join("|") + ")";
      } else {
        while (i < xmlData.length && !/\s/.test(xmlData[i])) {
          attributeType += xmlData[i];
          i++;
        }
        const validTypes = ["CDATA", "ID", "IDREF", "IDREFS", "ENTITY", "ENTITIES", "NMTOKEN", "NMTOKENS"];
        if (!this.suppressValidationErr && !validTypes.includes(attributeType.toUpperCase())) {
          throw new Error(`Invalid attribute type: "${attributeType}"`);
        }
      }
      i = skipWhitespace(xmlData, i);
      let defaultValue = "";
      if (xmlData.substring(i, i + 8).toUpperCase() === "#REQUIRED") {
        defaultValue = "#REQUIRED";
        i += 8;
      } else if (xmlData.substring(i, i + 7).toUpperCase() === "#IMPLIED") {
        defaultValue = "#IMPLIED";
        i += 7;
      } else {
        [i, defaultValue] = this.readIdentifierVal(xmlData, i, "ATTLIST");
      }
      return {
        elementName,
        attributeName,
        attributeType,
        defaultValue,
        index: i
      };
    }
  }
  const skipWhitespace = (data, index) => {
    while (index < data.length && /\s/.test(data[index])) {
      index++;
    }
    return index;
  };
  function hasSeq(data, seq, i) {
    for (let j = 0; j < seq.length; j++) {
      if (seq[j] !== data[i + j + 1]) return false;
    }
    return true;
  }
  function validateEntityName(name) {
    if (util2.isName(name))
      return name;
    else
      throw new Error(`Invalid entity name ${name}`);
  }
  DocTypeReader_1 = DocTypeReader;
  return DocTypeReader_1;
}
var strnum;
var hasRequiredStrnum;
function requireStrnum() {
  if (hasRequiredStrnum) return strnum;
  hasRequiredStrnum = 1;
  const hexRegex = /^[-+]?0x[a-fA-F0-9]+$/;
  const numRegex = /^([\-\+])?(0*)([0-9]*(\.[0-9]*)?)$/;
  const consider = {
    hex: true,
    // oct: false,
    leadingZeros: true,
    decimalPoint: ".",
    eNotation: true
    //skipLike: /regex/
  };
  function toNumber(str, options = {}) {
    options = Object.assign({}, consider, options);
    if (!str || typeof str !== "string") return str;
    let trimmedStr = str.trim();
    if (options.skipLike !== void 0 && options.skipLike.test(trimmedStr)) return str;
    else if (str === "0") return 0;
    else if (options.hex && hexRegex.test(trimmedStr)) {
      return parse_int(trimmedStr, 16);
    } else if (trimmedStr.search(/[eE]/) !== -1) {
      const notation = trimmedStr.match(/^([-\+])?(0*)([0-9]*(\.[0-9]*)?[eE][-\+]?[0-9]+)$/);
      if (notation) {
        if (options.leadingZeros) {
          trimmedStr = (notation[1] || "") + notation[3];
        } else {
          if (notation[2] === "0" && notation[3][0] === ".") ;
          else {
            return str;
          }
        }
        return options.eNotation ? Number(trimmedStr) : str;
      } else {
        return str;
      }
    } else {
      const match = numRegex.exec(trimmedStr);
      if (match) {
        const sign = match[1];
        const leadingZeros = match[2];
        let numTrimmedByZeros = trimZeros(match[3]);
        if (!options.leadingZeros && leadingZeros.length > 0 && sign && trimmedStr[2] !== ".") return str;
        else if (!options.leadingZeros && leadingZeros.length > 0 && !sign && trimmedStr[1] !== ".") return str;
        else if (options.leadingZeros && leadingZeros === str) return 0;
        else {
          const num = Number(trimmedStr);
          const numStr = "" + num;
          if (numStr.search(/[eE]/) !== -1) {
            if (options.eNotation) return num;
            else return str;
          } else if (trimmedStr.indexOf(".") !== -1) {
            if (numStr === "0" && numTrimmedByZeros === "") return num;
            else if (numStr === numTrimmedByZeros) return num;
            else if (sign && numStr === "-" + numTrimmedByZeros) return num;
            else return str;
          }
          if (leadingZeros) {
            return numTrimmedByZeros === numStr || sign + numTrimmedByZeros === numStr ? num : str;
          } else {
            return trimmedStr === numStr || trimmedStr === sign + numStr ? num : str;
          }
        }
      } else {
        return str;
      }
    }
  }
  function trimZeros(numStr) {
    if (numStr && numStr.indexOf(".") !== -1) {
      numStr = numStr.replace(/0+$/, "");
      if (numStr === ".") numStr = "0";
      else if (numStr[0] === ".") numStr = "0" + numStr;
      else if (numStr[numStr.length - 1] === ".") numStr = numStr.substr(0, numStr.length - 1);
      return numStr;
    }
    return numStr;
  }
  function parse_int(numStr, base) {
    if (parseInt) return parseInt(numStr, base);
    else if (Number.parseInt) return Number.parseInt(numStr, base);
    else if (window && window.parseInt) return window.parseInt(numStr, base);
    else throw new Error("parseInt, Number.parseInt, window.parseInt are not supported");
  }
  strnum = toNumber;
  return strnum;
}
var ignoreAttributes;
var hasRequiredIgnoreAttributes;
function requireIgnoreAttributes() {
  if (hasRequiredIgnoreAttributes) return ignoreAttributes;
  hasRequiredIgnoreAttributes = 1;
  function getIgnoreAttributesFn(ignoreAttributes2) {
    if (typeof ignoreAttributes2 === "function") {
      return ignoreAttributes2;
    }
    if (Array.isArray(ignoreAttributes2)) {
      return (attrName) => {
        for (const pattern of ignoreAttributes2) {
          if (typeof pattern === "string" && attrName === pattern) {
            return true;
          }
          if (pattern instanceof RegExp && pattern.test(attrName)) {
            return true;
          }
        }
      };
    }
    return () => false;
  }
  ignoreAttributes = getIgnoreAttributesFn;
  return ignoreAttributes;
}
var OrderedObjParser_1;
var hasRequiredOrderedObjParser;
function requireOrderedObjParser() {
  if (hasRequiredOrderedObjParser) return OrderedObjParser_1;
  hasRequiredOrderedObjParser = 1;
  const util2 = requireUtil();
  const xmlNode2 = requireXmlNode();
  const DocTypeReader = requireDocTypeReader();
  const toNumber = requireStrnum();
  const getIgnoreAttributesFn = requireIgnoreAttributes();
  class OrderedObjParser {
    constructor(options) {
      this.options = options;
      this.currentNode = null;
      this.tagsNodeStack = [];
      this.docTypeEntities = {};
      this.lastEntities = {
        "apos": { regex: /&(apos|#39|#x27);/g, val: "'" },
        "gt": { regex: /&(gt|#62|#x3E);/g, val: ">" },
        "lt": { regex: /&(lt|#60|#x3C);/g, val: "<" },
        "quot": { regex: /&(quot|#34|#x22);/g, val: '"' }
      };
      this.ampEntity = { regex: /&(amp|#38|#x26);/g, val: "&" };
      this.htmlEntities = {
        "space": { regex: /&(nbsp|#160);/g, val: " " },
        // "lt" : { regex: /&(lt|#60);/g, val: "<" },
        // "gt" : { regex: /&(gt|#62);/g, val: ">" },
        // "amp" : { regex: /&(amp|#38);/g, val: "&" },
        // "quot" : { regex: /&(quot|#34);/g, val: "\"" },
        // "apos" : { regex: /&(apos|#39);/g, val: "'" },
        "cent": { regex: /&(cent|#162);/g, val: "¢" },
        "pound": { regex: /&(pound|#163);/g, val: "£" },
        "yen": { regex: /&(yen|#165);/g, val: "¥" },
        "euro": { regex: /&(euro|#8364);/g, val: "€" },
        "copyright": { regex: /&(copy|#169);/g, val: "©" },
        "reg": { regex: /&(reg|#174);/g, val: "®" },
        "inr": { regex: /&(inr|#8377);/g, val: "₹" },
        "num_dec": { regex: /&#([0-9]{1,7});/g, val: (_, str) => fromCodePoint(str, 10, "&#") },
        "num_hex": { regex: /&#x([0-9a-fA-F]{1,6});/g, val: (_, str) => fromCodePoint(str, 16, "&#x") }
      };
      this.addExternalEntities = addExternalEntities;
      this.parseXml = parseXml;
      this.parseTextData = parseTextData;
      this.resolveNameSpace = resolveNameSpace;
      this.buildAttributesMap = buildAttributesMap;
      this.isItStopNode = isItStopNode;
      this.replaceEntitiesValue = replaceEntitiesValue;
      this.readStopNodeData = readStopNodeData;
      this.saveTextToParentTag = saveTextToParentTag;
      this.addChild = addChild;
      this.ignoreAttributesFn = getIgnoreAttributesFn(this.options.ignoreAttributes);
      this.entityExpansionCount = 0;
      this.currentExpandedLength = 0;
      if (this.options.stopNodes && this.options.stopNodes.length > 0) {
        this.stopNodesExact = /* @__PURE__ */ new Set();
        this.stopNodesWildcard = /* @__PURE__ */ new Set();
        for (let i = 0; i < this.options.stopNodes.length; i++) {
          const stopNodeExp = this.options.stopNodes[i];
          if (typeof stopNodeExp !== "string") continue;
          if (stopNodeExp.startsWith("*.")) {
            this.stopNodesWildcard.add(stopNodeExp.substring(2));
          } else {
            this.stopNodesExact.add(stopNodeExp);
          }
        }
      }
    }
  }
  function addExternalEntities(externalEntities) {
    const entKeys = Object.keys(externalEntities);
    for (let i = 0; i < entKeys.length; i++) {
      const ent = entKeys[i];
      const escaped = ent.replace(/[.\-+*:]/g, "\\.");
      this.lastEntities[ent] = {
        regex: new RegExp("&" + escaped + ";", "g"),
        val: externalEntities[ent]
      };
    }
  }
  function parseTextData(val, tagName, jPath, dontTrim, hasAttributes, isLeafNode, escapeEntities) {
    if (val !== void 0) {
      if (this.options.trimValues && !dontTrim) {
        val = val.trim();
      }
      if (val.length > 0) {
        if (!escapeEntities) val = this.replaceEntitiesValue(val, tagName, jPath);
        const newval = this.options.tagValueProcessor(tagName, val, jPath, hasAttributes, isLeafNode);
        if (newval === null || newval === void 0) {
          return val;
        } else if (typeof newval !== typeof val || newval !== val) {
          return newval;
        } else if (this.options.trimValues) {
          return parseValue(val, this.options.parseTagValue, this.options.numberParseOptions);
        } else {
          const trimmedVal = val.trim();
          if (trimmedVal === val) {
            return parseValue(val, this.options.parseTagValue, this.options.numberParseOptions);
          } else {
            return val;
          }
        }
      }
    }
  }
  function resolveNameSpace(tagname) {
    if (this.options.removeNSPrefix) {
      const tags = tagname.split(":");
      const prefix = tagname.charAt(0) === "/" ? "/" : "";
      if (tags[0] === "xmlns") {
        return "";
      }
      if (tags.length === 2) {
        tagname = prefix + tags[1];
      }
    }
    return tagname;
  }
  const attrsRegx = new RegExp(`([^\\s=]+)\\s*(=\\s*(['"])([\\s\\S]*?)\\3)?`, "gm");
  function buildAttributesMap(attrStr, jPath, tagName) {
    if (this.options.ignoreAttributes !== true && typeof attrStr === "string") {
      const matches = util2.getAllMatches(attrStr, attrsRegx);
      const len = matches.length;
      const attrs = {};
      for (let i = 0; i < len; i++) {
        const attrName = this.resolveNameSpace(matches[i][1]);
        if (this.ignoreAttributesFn(attrName, jPath)) {
          continue;
        }
        let oldVal = matches[i][4];
        let aName = this.options.attributeNamePrefix + attrName;
        if (attrName.length) {
          if (this.options.transformAttributeName) {
            aName = this.options.transformAttributeName(aName);
          }
          aName = sanitizeName(aName, this.options);
          if (oldVal !== void 0) {
            if (this.options.trimValues) {
              oldVal = oldVal.trim();
            }
            oldVal = this.replaceEntitiesValue(oldVal, tagName, jPath);
            const newVal = this.options.attributeValueProcessor(attrName, oldVal, jPath);
            if (newVal === null || newVal === void 0) {
              attrs[aName] = oldVal;
            } else if (typeof newVal !== typeof oldVal || newVal !== oldVal) {
              attrs[aName] = newVal;
            } else {
              attrs[aName] = parseValue(
                oldVal,
                this.options.parseAttributeValue,
                this.options.numberParseOptions
              );
            }
          } else if (this.options.allowBooleanAttributes) {
            attrs[aName] = true;
          }
        }
      }
      if (!Object.keys(attrs).length) {
        return;
      }
      if (this.options.attributesGroupName) {
        const attrCollection = {};
        attrCollection[this.options.attributesGroupName] = attrs;
        return attrCollection;
      }
      return attrs;
    }
  }
  const parseXml = function(xmlData) {
    xmlData = xmlData.replace(/\r\n?/g, "\n");
    const xmlObj = new xmlNode2("!xml");
    let currentNode = xmlObj;
    let textData = "";
    let jPath = "";
    this.entityExpansionCount = 0;
    this.currentExpandedLength = 0;
    const docTypeReader = new DocTypeReader(this.options.processEntities);
    for (let i = 0; i < xmlData.length; i++) {
      const ch = xmlData[i];
      if (ch === "<") {
        if (xmlData[i + 1] === "/") {
          const closeIndex = findClosingIndex(xmlData, ">", i, "Closing Tag is not closed.");
          let tagName = xmlData.substring(i + 2, closeIndex).trim();
          if (this.options.removeNSPrefix) {
            const colonIndex = tagName.indexOf(":");
            if (colonIndex !== -1) {
              tagName = tagName.substr(colonIndex + 1);
            }
          }
          if (this.options.transformTagName) {
            tagName = this.options.transformTagName(tagName);
          }
          if (currentNode) {
            textData = this.saveTextToParentTag(textData, currentNode, jPath);
          }
          const lastTagName = jPath.substring(jPath.lastIndexOf(".") + 1);
          if (tagName && this.options.unpairedTags.indexOf(tagName) !== -1) {
            throw new Error(`Unpaired tag can not be used as closing tag: </${tagName}>`);
          }
          let propIndex = 0;
          if (lastTagName && this.options.unpairedTags.indexOf(lastTagName) !== -1) {
            propIndex = jPath.lastIndexOf(".", jPath.lastIndexOf(".") - 1);
            this.tagsNodeStack.pop();
          } else {
            propIndex = jPath.lastIndexOf(".");
          }
          jPath = jPath.substring(0, propIndex);
          currentNode = this.tagsNodeStack.pop();
          textData = "";
          i = closeIndex;
        } else if (xmlData[i + 1] === "?") {
          let tagData = readTagExp(xmlData, i, false, "?>");
          if (!tagData) throw new Error("Pi Tag is not closed.");
          textData = this.saveTextToParentTag(textData, currentNode, jPath);
          if (this.options.ignoreDeclaration && tagData.tagName === "?xml" || this.options.ignorePiTags) ;
          else {
            const childNode = new xmlNode2(tagData.tagName);
            childNode.add(this.options.textNodeName, "");
            if (tagData.tagName !== tagData.tagExp && tagData.attrExpPresent) {
              childNode[":@"] = this.buildAttributesMap(tagData.tagExp, jPath, tagData.tagName);
            }
            this.addChild(currentNode, childNode, jPath, i);
          }
          i = tagData.closeIndex + 1;
        } else if (xmlData.substr(i + 1, 3) === "!--") {
          const endIndex = findClosingIndex(xmlData, "-->", i + 4, "Comment is not closed.");
          if (this.options.commentPropName) {
            const comment = xmlData.substring(i + 4, endIndex - 2);
            textData = this.saveTextToParentTag(textData, currentNode, jPath);
            currentNode.add(this.options.commentPropName, [{ [this.options.textNodeName]: comment }]);
          }
          i = endIndex;
        } else if (xmlData.substr(i + 1, 2) === "!D") {
          const result = docTypeReader.readDocType(xmlData, i);
          this.docTypeEntities = result.entities;
          i = result.i;
        } else if (xmlData.substr(i + 1, 2) === "![") {
          const closeIndex = findClosingIndex(xmlData, "]]>", i, "CDATA is not closed.") - 2;
          const tagExp = xmlData.substring(i + 9, closeIndex);
          textData = this.saveTextToParentTag(textData, currentNode, jPath);
          let val = this.parseTextData(tagExp, currentNode.tagname, jPath, true, false, true, true);
          if (val == void 0) val = "";
          if (this.options.cdataPropName) {
            currentNode.add(this.options.cdataPropName, [{ [this.options.textNodeName]: tagExp }]);
          } else {
            currentNode.add(this.options.textNodeName, val);
          }
          i = closeIndex + 2;
        } else {
          let result = readTagExp(xmlData, i, this.options.removeNSPrefix);
          let tagName = result.tagName;
          const rawTagName = result.rawTagName;
          let tagExp = result.tagExp;
          let attrExpPresent = result.attrExpPresent;
          let closeIndex = result.closeIndex;
          if (this.options.transformTagName) {
            const newTagName = this.options.transformTagName(tagName);
            if (tagExp === tagName) {
              tagExp = newTagName;
            }
            tagName = newTagName;
          }
          if (this.options.strictReservedNames && (tagName === this.options.commentPropName || tagName === this.options.cdataPropName || tagName === this.options.textNodeName || tagName === this.options.attributesGroupName)) {
            throw new Error(`Invalid tag name: ${tagName}`);
          }
          if (currentNode && textData) {
            if (currentNode.tagname !== "!xml") {
              textData = this.saveTextToParentTag(textData, currentNode, jPath, false);
            }
          }
          const lastTag = currentNode;
          if (lastTag && this.options.unpairedTags.indexOf(lastTag.tagname) !== -1) {
            currentNode = this.tagsNodeStack.pop();
            jPath = jPath.substring(0, jPath.lastIndexOf("."));
          }
          if (tagName !== xmlObj.tagname) {
            jPath += jPath ? "." + tagName : tagName;
          }
          const startIndex = i;
          if (this.isItStopNode(this.stopNodesExact, this.stopNodesWildcard, jPath, tagName)) {
            let tagContent = "";
            if (tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1) {
              if (tagName[tagName.length - 1] === "/") {
                tagName = tagName.substr(0, tagName.length - 1);
                jPath = jPath.substr(0, jPath.length - 1);
                tagExp = tagName;
              } else {
                tagExp = tagExp.substr(0, tagExp.length - 1);
              }
              i = result.closeIndex;
            } else if (this.options.unpairedTags.indexOf(tagName) !== -1) {
              i = result.closeIndex;
            } else {
              const result2 = this.readStopNodeData(xmlData, rawTagName, closeIndex + 1);
              if (!result2) throw new Error(`Unexpected end of ${rawTagName}`);
              i = result2.i;
              tagContent = result2.tagContent;
            }
            const childNode = new xmlNode2(tagName);
            if (tagName !== tagExp && attrExpPresent) {
              childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
            }
            if (tagContent) {
              tagContent = this.parseTextData(tagContent, tagName, jPath, true, attrExpPresent, true, true);
            }
            jPath = jPath.substr(0, jPath.lastIndexOf("."));
            childNode.add(this.options.textNodeName, tagContent);
            this.addChild(currentNode, childNode, jPath, startIndex);
          } else {
            if (tagExp.length > 0 && tagExp.lastIndexOf("/") === tagExp.length - 1) {
              if (tagName[tagName.length - 1] === "/") {
                tagName = tagName.substr(0, tagName.length - 1);
                jPath = jPath.substr(0, jPath.length - 1);
                tagExp = tagName;
              } else {
                tagExp = tagExp.substr(0, tagExp.length - 1);
              }
              if (this.options.transformTagName) {
                const newTagName = this.options.transformTagName(tagName);
                if (tagExp === tagName) {
                  tagExp = newTagName;
                }
                tagName = newTagName;
              }
              const childNode = new xmlNode2(tagName);
              if (tagName !== tagExp && attrExpPresent) {
                childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
              }
              this.addChild(currentNode, childNode, jPath, startIndex);
              jPath = jPath.substr(0, jPath.lastIndexOf("."));
            } else if (this.options.unpairedTags.indexOf(tagName) !== -1) {
              const childNode = new xmlNode2(tagName);
              if (tagName !== tagExp && attrExpPresent) {
                childNode[":@"] = this.buildAttributesMap(tagExp, jPath);
              }
              this.addChild(currentNode, childNode, jPath, startIndex);
              jPath = jPath.substr(0, jPath.lastIndexOf("."));
              i = result.closeIndex;
              continue;
            } else {
              const childNode = new xmlNode2(tagName);
              if (this.tagsNodeStack.length > this.options.maxNestedTags) {
                throw new Error("Maximum nested tags exceeded");
              }
              this.tagsNodeStack.push(currentNode);
              if (tagName !== tagExp && attrExpPresent) {
                childNode[":@"] = this.buildAttributesMap(tagExp, jPath, tagName);
              }
              this.addChild(currentNode, childNode, jPath);
              currentNode = childNode;
            }
            textData = "";
            i = closeIndex;
          }
        }
      } else {
        textData += xmlData[i];
      }
    }
    return xmlObj.child;
  };
  function addChild(currentNode, childNode, jPath, startIndex) {
    if (!this.options.captureMetaData) startIndex = void 0;
    const result = this.options.updateTag(childNode.tagname, jPath, childNode[":@"]);
    if (result === false) ;
    else if (typeof result === "string") {
      childNode.tagname = result;
      currentNode.addChild(childNode, startIndex);
    } else {
      currentNode.addChild(childNode, startIndex);
    }
  }
  const replaceEntitiesValue = function(val, tagName, jPath) {
    if (val.indexOf("&") === -1) {
      return val;
    }
    const entityConfig = this.options.processEntities;
    if (!entityConfig.enabled) {
      return val;
    }
    if (entityConfig.allowedTags) {
      if (!entityConfig.allowedTags.includes(tagName)) {
        return val;
      }
    }
    if (entityConfig.tagFilter) {
      if (!entityConfig.tagFilter(tagName, jPath)) {
        return val;
      }
    }
    for (let entityName in this.docTypeEntities) {
      const entity = this.docTypeEntities[entityName];
      const matches = val.match(entity.regx);
      if (matches) {
        this.entityExpansionCount += matches.length;
        if (entityConfig.maxTotalExpansions && this.entityExpansionCount > entityConfig.maxTotalExpansions) {
          throw new Error(
            `Entity expansion limit exceeded: ${this.entityExpansionCount} > ${entityConfig.maxTotalExpansions}`
          );
        }
        const lengthBefore = val.length;
        val = val.replace(entity.regx, entity.val);
        if (entityConfig.maxExpandedLength) {
          this.currentExpandedLength += val.length - lengthBefore;
          if (this.currentExpandedLength > entityConfig.maxExpandedLength) {
            throw new Error(
              `Total expanded content size exceeded: ${this.currentExpandedLength} > ${entityConfig.maxExpandedLength}`
            );
          }
        }
      }
    }
    if (val.indexOf("&") === -1) return val;
    for (const entityName of Object.keys(this.lastEntities)) {
      const entity = this.lastEntities[entityName];
      const matches = val.match(entity.regex);
      if (matches) {
        this.entityExpansionCount += matches.length;
        if (entityConfig.maxTotalExpansions && this.entityExpansionCount > entityConfig.maxTotalExpansions) {
          throw new Error(
            `Entity expansion limit exceeded: ${this.entityExpansionCount} > ${entityConfig.maxTotalExpansions}`
          );
        }
      }
      val = val.replace(entity.regex, entity.val);
    }
    if (val.indexOf("&") === -1) return val;
    if (this.options.htmlEntities) {
      for (const entityName of Object.keys(this.htmlEntities)) {
        const entity = this.htmlEntities[entityName];
        const matches = val.match(entity.regex);
        if (matches) {
          this.entityExpansionCount += matches.length;
          if (entityConfig.maxTotalExpansions && this.entityExpansionCount > entityConfig.maxTotalExpansions) {
            throw new Error(
              `Entity expansion limit exceeded: ${this.entityExpansionCount} > ${entityConfig.maxTotalExpansions}`
            );
          }
        }
        val = val.replace(entity.regex, entity.val);
      }
    }
    val = val.replace(this.ampEntity.regex, this.ampEntity.val);
    return val;
  };
  function saveTextToParentTag(textData, parentNode, jPath, isLeafNode) {
    if (textData) {
      if (isLeafNode === void 0) isLeafNode = parentNode.child.length === 0;
      textData = this.parseTextData(
        textData,
        parentNode.tagname,
        jPath,
        false,
        parentNode[":@"] ? Object.keys(parentNode[":@"]).length !== 0 : false,
        isLeafNode
      );
      if (textData !== void 0 && textData !== "")
        parentNode.add(this.options.textNodeName, textData);
      textData = "";
    }
    return textData;
  }
  function isItStopNode(stopNodesExact, stopNodesWildcard, jPath, currentTagName) {
    if (stopNodesWildcard && stopNodesWildcard.has(currentTagName)) return true;
    if (stopNodesExact && stopNodesExact.has(jPath)) return true;
    return false;
  }
  function tagExpWithClosingIndex(xmlData, i, closingChar = ">") {
    let attrBoundary;
    let tagExp = "";
    for (let index = i; index < xmlData.length; index++) {
      let ch = xmlData[index];
      if (attrBoundary) {
        if (ch === attrBoundary) attrBoundary = "";
      } else if (ch === '"' || ch === "'") {
        attrBoundary = ch;
      } else if (ch === closingChar[0]) {
        if (closingChar[1]) {
          if (xmlData[index + 1] === closingChar[1]) {
            return {
              data: tagExp,
              index
            };
          }
        } else {
          return {
            data: tagExp,
            index
          };
        }
      } else if (ch === "	") {
        ch = " ";
      }
      tagExp += ch;
    }
  }
  function findClosingIndex(xmlData, str, i, errMsg) {
    const closingIndex = xmlData.indexOf(str, i);
    if (closingIndex === -1) {
      throw new Error(errMsg);
    } else {
      return closingIndex + str.length - 1;
    }
  }
  function readTagExp(xmlData, i, removeNSPrefix, closingChar = ">") {
    const result = tagExpWithClosingIndex(xmlData, i + 1, closingChar);
    if (!result) return;
    let tagExp = result.data;
    const closeIndex = result.index;
    const separatorIndex = tagExp.search(/\s/);
    let tagName = tagExp;
    let attrExpPresent = true;
    if (separatorIndex !== -1) {
      tagName = tagExp.substring(0, separatorIndex);
      tagExp = tagExp.substring(separatorIndex + 1).trimStart();
    }
    const rawTagName = tagName;
    if (removeNSPrefix) {
      const colonIndex = tagName.indexOf(":");
      if (colonIndex !== -1) {
        tagName = tagName.substr(colonIndex + 1);
        attrExpPresent = tagName !== result.data.substr(colonIndex + 1);
      }
    }
    return {
      tagName,
      tagExp,
      closeIndex,
      attrExpPresent,
      rawTagName
    };
  }
  function readStopNodeData(xmlData, tagName, i) {
    const startIndex = i;
    let openTagCount = 1;
    for (; i < xmlData.length; i++) {
      if (xmlData[i] === "<") {
        if (xmlData[i + 1] === "/") {
          const closeIndex = findClosingIndex(xmlData, ">", i, `${tagName} is not closed`);
          let closeTagName = xmlData.substring(i + 2, closeIndex).trim();
          if (closeTagName === tagName) {
            openTagCount--;
            if (openTagCount === 0) {
              return {
                tagContent: xmlData.substring(startIndex, i),
                i: closeIndex
              };
            }
          }
          i = closeIndex;
        } else if (xmlData[i + 1] === "?") {
          const closeIndex = findClosingIndex(xmlData, "?>", i + 1, "StopNode is not closed.");
          i = closeIndex;
        } else if (xmlData.substr(i + 1, 3) === "!--") {
          const closeIndex = findClosingIndex(xmlData, "-->", i + 3, "StopNode is not closed.");
          i = closeIndex;
        } else if (xmlData.substr(i + 1, 2) === "![") {
          const closeIndex = findClosingIndex(xmlData, "]]>", i, "StopNode is not closed.") - 2;
          i = closeIndex;
        } else {
          const tagData = readTagExp(xmlData, i, ">");
          if (tagData) {
            const openTagName = tagData && tagData.tagName;
            if (openTagName === tagName && tagData.tagExp[tagData.tagExp.length - 1] !== "/") {
              openTagCount++;
            }
            i = tagData.closeIndex;
          }
        }
      }
    }
  }
  function parseValue(val, shouldParse, options) {
    if (shouldParse && typeof val === "string") {
      const newval = val.trim();
      if (newval === "true") return true;
      else if (newval === "false") return false;
      else return toNumber(val, options);
    } else {
      if (util2.isExist(val)) {
        return val;
      } else {
        return "";
      }
    }
  }
  function fromCodePoint(str, base, prefix) {
    const codePoint = Number.parseInt(str, base);
    if (codePoint >= 0 && codePoint <= 1114111) {
      return String.fromCodePoint(codePoint);
    } else {
      return prefix + str + ";";
    }
  }
  function sanitizeName(name, options) {
    if (util2.criticalProperties.includes(name)) {
      throw new Error(`[SECURITY] Invalid name: "${name}" is a reserved JavaScript keyword that could cause prototype pollution`);
    } else if (util2.DANGEROUS_PROPERTY_NAMES.includes(name)) {
      return options.onDangerousProperty(name);
    }
    return name;
  }
  OrderedObjParser_1 = OrderedObjParser;
  return OrderedObjParser_1;
}
var node2json = {};
var hasRequiredNode2json;
function requireNode2json() {
  if (hasRequiredNode2json) return node2json;
  hasRequiredNode2json = 1;
  function prettify(node, options) {
    return compress(node, options);
  }
  function compress(arr, options, jPath) {
    let text;
    const compressedObj = {};
    for (let i = 0; i < arr.length; i++) {
      const tagObj = arr[i];
      const property = propName(tagObj);
      let newJpath = "";
      if (jPath === void 0) newJpath = property;
      else newJpath = jPath + "." + property;
      if (property === options.textNodeName) {
        if (text === void 0) text = tagObj[property];
        else text += "" + tagObj[property];
      } else if (property === void 0) {
        continue;
      } else if (tagObj[property]) {
        let val = compress(tagObj[property], options, newJpath);
        const isLeaf = isLeafTag(val, options);
        if (tagObj[":@"]) {
          assignAttributes(val, tagObj[":@"], newJpath, options);
        } else if (Object.keys(val).length === 1 && val[options.textNodeName] !== void 0 && !options.alwaysCreateTextNode) {
          val = val[options.textNodeName];
        } else if (Object.keys(val).length === 0) {
          if (options.alwaysCreateTextNode) val[options.textNodeName] = "";
          else val = "";
        }
        if (compressedObj[property] !== void 0 && compressedObj.hasOwnProperty(property)) {
          if (!Array.isArray(compressedObj[property])) {
            compressedObj[property] = [compressedObj[property]];
          }
          compressedObj[property].push(val);
        } else {
          if (options.isArray(property, newJpath, isLeaf)) {
            compressedObj[property] = [val];
          } else {
            compressedObj[property] = val;
          }
        }
      }
    }
    if (typeof text === "string") {
      if (text.length > 0) compressedObj[options.textNodeName] = text;
    } else if (text !== void 0) compressedObj[options.textNodeName] = text;
    return compressedObj;
  }
  function propName(obj) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key !== ":@") return key;
    }
  }
  function assignAttributes(obj, attrMap, jpath, options) {
    if (attrMap) {
      const keys = Object.keys(attrMap);
      const len = keys.length;
      for (let i = 0; i < len; i++) {
        const atrrName = keys[i];
        if (options.isArray(atrrName, jpath + "." + atrrName, true, true)) {
          obj[atrrName] = [attrMap[atrrName]];
        } else {
          obj[atrrName] = attrMap[atrrName];
        }
      }
    }
  }
  function isLeafTag(obj, options) {
    const { textNodeName } = options;
    const propCount = Object.keys(obj).length;
    if (propCount === 0) {
      return true;
    }
    if (propCount === 1 && (obj[textNodeName] || typeof obj[textNodeName] === "boolean" || obj[textNodeName] === 0)) {
      return true;
    }
    return false;
  }
  node2json.prettify = prettify;
  return node2json;
}
var XMLParser_1;
var hasRequiredXMLParser;
function requireXMLParser() {
  if (hasRequiredXMLParser) return XMLParser_1;
  hasRequiredXMLParser = 1;
  const { buildOptions } = requireOptionsBuilder();
  const OrderedObjParser = requireOrderedObjParser();
  const { prettify } = requireNode2json();
  const validator2 = requireValidator();
  class XMLParser {
    constructor(options) {
      this.externalEntities = {};
      this.options = buildOptions(options);
    }
    /**
     * Parse XML dats to JS object 
     * @param {string|Buffer} xmlData 
     * @param {boolean|Object} validationOption 
     */
    parse(xmlData, validationOption) {
      if (typeof xmlData === "string") ;
      else if (xmlData.toString) {
        xmlData = xmlData.toString();
      } else {
        throw new Error("XML data is accepted in String or Bytes[] form.");
      }
      if (validationOption) {
        if (validationOption === true) validationOption = {};
        const result = validator2.validate(xmlData, validationOption);
        if (result !== true) {
          throw Error(`${result.err.msg}:${result.err.line}:${result.err.col}`);
        }
      }
      const orderedObjParser = new OrderedObjParser(this.options);
      orderedObjParser.addExternalEntities(this.externalEntities);
      const orderedResult = orderedObjParser.parseXml(xmlData);
      if (this.options.preserveOrder || orderedResult === void 0) return orderedResult;
      else return prettify(orderedResult, this.options);
    }
    /**
     * Add Entity which is not by default supported by this library
     * @param {string} key 
     * @param {string} value 
     */
    addEntity(key, value) {
      if (value.indexOf("&") !== -1) {
        throw new Error("Entity value can't have '&'");
      } else if (key.indexOf("&") !== -1 || key.indexOf(";") !== -1) {
        throw new Error("An entity must be set without '&' and ';'. Eg. use '#xD' for '&#xD;'");
      } else if (value === "&") {
        throw new Error("An entity with value '&' is not permitted");
      } else {
        this.externalEntities[key] = value;
      }
    }
  }
  XMLParser_1 = XMLParser;
  return XMLParser_1;
}
var orderedJs2Xml;
var hasRequiredOrderedJs2Xml;
function requireOrderedJs2Xml() {
  if (hasRequiredOrderedJs2Xml) return orderedJs2Xml;
  hasRequiredOrderedJs2Xml = 1;
  const EOL = "\n";
  function toXml(jArray, options) {
    let indentation = "";
    if (options.format && options.indentBy.length > 0) {
      indentation = EOL;
    }
    return arrToStr(jArray, options, "", indentation);
  }
  function arrToStr(arr, options, jPath, indentation) {
    let xmlStr = "";
    let isPreviousElementTag = false;
    if (!Array.isArray(arr)) {
      if (arr !== void 0 && arr !== null) {
        let text = arr.toString();
        text = replaceEntitiesValue(text, options);
        return text;
      }
      return "";
    }
    for (let i = 0; i < arr.length; i++) {
      const tagObj = arr[i];
      const tagName = propName(tagObj);
      if (tagName === void 0) continue;
      let newJPath = "";
      if (jPath.length === 0) newJPath = tagName;
      else newJPath = `${jPath}.${tagName}`;
      if (tagName === options.textNodeName) {
        let tagText = tagObj[tagName];
        if (!isStopNode(newJPath, options)) {
          tagText = options.tagValueProcessor(tagName, tagText);
          tagText = replaceEntitiesValue(tagText, options);
        }
        if (isPreviousElementTag) {
          xmlStr += indentation;
        }
        xmlStr += tagText;
        isPreviousElementTag = false;
        continue;
      } else if (tagName === options.cdataPropName) {
        if (isPreviousElementTag) {
          xmlStr += indentation;
        }
        xmlStr += `<![CDATA[${tagObj[tagName][0][options.textNodeName]}]]>`;
        isPreviousElementTag = false;
        continue;
      } else if (tagName === options.commentPropName) {
        xmlStr += indentation + `<!--${tagObj[tagName][0][options.textNodeName]}-->`;
        isPreviousElementTag = true;
        continue;
      } else if (tagName[0] === "?") {
        const attStr2 = attr_to_str(tagObj[":@"], options);
        const tempInd = tagName === "?xml" ? "" : indentation;
        let piTextNodeName = tagObj[tagName][0][options.textNodeName];
        piTextNodeName = piTextNodeName.length !== 0 ? " " + piTextNodeName : "";
        xmlStr += tempInd + `<${tagName}${piTextNodeName}${attStr2}?>`;
        isPreviousElementTag = true;
        continue;
      }
      let newIdentation = indentation;
      if (newIdentation !== "") {
        newIdentation += options.indentBy;
      }
      const attStr = attr_to_str(tagObj[":@"], options);
      const tagStart = indentation + `<${tagName}${attStr}`;
      const tagValue = arrToStr(tagObj[tagName], options, newJPath, newIdentation);
      if (options.unpairedTags.indexOf(tagName) !== -1) {
        if (options.suppressUnpairedNode) xmlStr += tagStart + ">";
        else xmlStr += tagStart + "/>";
      } else if ((!tagValue || tagValue.length === 0) && options.suppressEmptyNode) {
        xmlStr += tagStart + "/>";
      } else if (tagValue && tagValue.endsWith(">")) {
        xmlStr += tagStart + `>${tagValue}${indentation}</${tagName}>`;
      } else {
        xmlStr += tagStart + ">";
        if (tagValue && indentation !== "" && (tagValue.includes("/>") || tagValue.includes("</"))) {
          xmlStr += indentation + options.indentBy + tagValue + indentation;
        } else {
          xmlStr += tagValue;
        }
        xmlStr += `</${tagName}>`;
      }
      isPreviousElementTag = true;
    }
    return xmlStr;
  }
  function propName(obj) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      if (key !== ":@") return key;
    }
  }
  function attr_to_str(attrMap, options) {
    let attrStr = "";
    if (attrMap && !options.ignoreAttributes) {
      for (let attr in attrMap) {
        if (!Object.prototype.hasOwnProperty.call(attrMap, attr)) continue;
        let attrVal = options.attributeValueProcessor(attr, attrMap[attr]);
        attrVal = replaceEntitiesValue(attrVal, options);
        if (attrVal === true && options.suppressBooleanAttributes) {
          attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}`;
        } else {
          attrStr += ` ${attr.substr(options.attributeNamePrefix.length)}="${attrVal}"`;
        }
      }
    }
    return attrStr;
  }
  function isStopNode(jPath, options) {
    jPath = jPath.substr(0, jPath.length - options.textNodeName.length - 1);
    let tagName = jPath.substr(jPath.lastIndexOf(".") + 1);
    for (let index in options.stopNodes) {
      if (options.stopNodes[index] === jPath || options.stopNodes[index] === "*." + tagName) return true;
    }
    return false;
  }
  function replaceEntitiesValue(textValue, options) {
    if (textValue && textValue.length > 0 && options.processEntities) {
      for (let i = 0; i < options.entities.length; i++) {
        const entity = options.entities[i];
        textValue = textValue.replace(entity.regex, entity.val);
      }
    }
    return textValue;
  }
  orderedJs2Xml = toXml;
  return orderedJs2Xml;
}
var json2xml;
var hasRequiredJson2xml;
function requireJson2xml() {
  if (hasRequiredJson2xml) return json2xml;
  hasRequiredJson2xml = 1;
  const buildFromOrderedJs = requireOrderedJs2Xml();
  const getIgnoreAttributesFn = requireIgnoreAttributes();
  const defaultOptions = {
    attributeNamePrefix: "@_",
    attributesGroupName: false,
    textNodeName: "#text",
    ignoreAttributes: true,
    cdataPropName: false,
    format: false,
    indentBy: "  ",
    suppressEmptyNode: false,
    suppressUnpairedNode: true,
    suppressBooleanAttributes: true,
    tagValueProcessor: function(key, a) {
      return a;
    },
    attributeValueProcessor: function(attrName, a) {
      return a;
    },
    preserveOrder: false,
    commentPropName: false,
    unpairedTags: [],
    entities: [
      { regex: new RegExp("&", "g"), val: "&amp;" },
      //it must be on top
      { regex: new RegExp(">", "g"), val: "&gt;" },
      { regex: new RegExp("<", "g"), val: "&lt;" },
      { regex: new RegExp("'", "g"), val: "&apos;" },
      { regex: new RegExp('"', "g"), val: "&quot;" }
    ],
    processEntities: true,
    stopNodes: [],
    // transformTagName: false,
    // transformAttributeName: false,
    oneListGroup: false
  };
  function Builder(options) {
    this.options = Object.assign({}, defaultOptions, options);
    if (this.options.ignoreAttributes === true || this.options.attributesGroupName) {
      this.isAttribute = function() {
        return false;
      };
    } else {
      this.ignoreAttributesFn = getIgnoreAttributesFn(this.options.ignoreAttributes);
      this.attrPrefixLen = this.options.attributeNamePrefix.length;
      this.isAttribute = isAttribute;
    }
    this.processTextOrObjNode = processTextOrObjNode;
    if (this.options.format) {
      this.indentate = indentate;
      this.tagEndChar = ">\n";
      this.newLine = "\n";
    } else {
      this.indentate = function() {
        return "";
      };
      this.tagEndChar = ">";
      this.newLine = "";
    }
  }
  Builder.prototype.build = function(jObj) {
    if (this.options.preserveOrder) {
      return buildFromOrderedJs(jObj, this.options);
    } else {
      if (Array.isArray(jObj) && this.options.arrayNodeName && this.options.arrayNodeName.length > 1) {
        jObj = {
          [this.options.arrayNodeName]: jObj
        };
      }
      return this.j2x(jObj, 0, []).val;
    }
  };
  Builder.prototype.j2x = function(jObj, level, ajPath) {
    let attrStr = "";
    let val = "";
    const jPath = ajPath.join(".");
    for (let key in jObj) {
      if (!Object.prototype.hasOwnProperty.call(jObj, key)) continue;
      if (typeof jObj[key] === "undefined") {
        if (this.isAttribute(key)) {
          val += "";
        }
      } else if (jObj[key] === null) {
        if (this.isAttribute(key)) {
          val += "";
        } else if (key === this.options.cdataPropName) {
          val += "";
        } else if (key[0] === "?") {
          val += this.indentate(level) + "<" + key + "?" + this.tagEndChar;
        } else {
          val += this.indentate(level) + "<" + key + "/" + this.tagEndChar;
        }
      } else if (jObj[key] instanceof Date) {
        val += this.buildTextValNode(jObj[key], key, "", level);
      } else if (typeof jObj[key] !== "object") {
        const attr = this.isAttribute(key);
        if (attr && !this.ignoreAttributesFn(attr, jPath)) {
          attrStr += this.buildAttrPairStr(attr, "" + jObj[key]);
        } else if (!attr) {
          if (key === this.options.textNodeName) {
            let newval = this.options.tagValueProcessor(key, "" + jObj[key]);
            val += this.replaceEntitiesValue(newval);
          } else {
            val += this.buildTextValNode(jObj[key], key, "", level);
          }
        }
      } else if (Array.isArray(jObj[key])) {
        const arrLen = jObj[key].length;
        let listTagVal = "";
        let listTagAttr = "";
        for (let j = 0; j < arrLen; j++) {
          const item = jObj[key][j];
          if (typeof item === "undefined") ;
          else if (item === null) {
            if (key[0] === "?") val += this.indentate(level) + "<" + key + "?" + this.tagEndChar;
            else val += this.indentate(level) + "<" + key + "/" + this.tagEndChar;
          } else if (typeof item === "object") {
            if (this.options.oneListGroup) {
              const result = this.j2x(item, level + 1, ajPath.concat(key));
              listTagVal += result.val;
              if (this.options.attributesGroupName && item.hasOwnProperty(this.options.attributesGroupName)) {
                listTagAttr += result.attrStr;
              }
            } else {
              listTagVal += this.processTextOrObjNode(item, key, level, ajPath);
            }
          } else {
            if (this.options.oneListGroup) {
              let textValue = this.options.tagValueProcessor(key, item);
              textValue = this.replaceEntitiesValue(textValue);
              listTagVal += textValue;
            } else {
              listTagVal += this.buildTextValNode(item, key, "", level);
            }
          }
        }
        if (this.options.oneListGroup) {
          listTagVal = this.buildObjectNode(listTagVal, key, listTagAttr, level);
        }
        val += listTagVal;
      } else {
        if (this.options.attributesGroupName && key === this.options.attributesGroupName) {
          const Ks = Object.keys(jObj[key]);
          const L = Ks.length;
          for (let j = 0; j < L; j++) {
            attrStr += this.buildAttrPairStr(Ks[j], "" + jObj[key][Ks[j]]);
          }
        } else {
          val += this.processTextOrObjNode(jObj[key], key, level, ajPath);
        }
      }
    }
    return { attrStr, val };
  };
  Builder.prototype.buildAttrPairStr = function(attrName, val) {
    val = this.options.attributeValueProcessor(attrName, "" + val);
    val = this.replaceEntitiesValue(val);
    if (this.options.suppressBooleanAttributes && val === "true") {
      return " " + attrName;
    } else return " " + attrName + '="' + val + '"';
  };
  function processTextOrObjNode(object, key, level, ajPath) {
    const result = this.j2x(object, level + 1, ajPath.concat(key));
    if (object[this.options.textNodeName] !== void 0 && Object.keys(object).length === 1) {
      return this.buildTextValNode(object[this.options.textNodeName], key, result.attrStr, level);
    } else {
      return this.buildObjectNode(result.val, key, result.attrStr, level);
    }
  }
  Builder.prototype.buildObjectNode = function(val, key, attrStr, level) {
    if (val === "") {
      if (key[0] === "?") return this.indentate(level) + "<" + key + attrStr + "?" + this.tagEndChar;
      else {
        return this.indentate(level) + "<" + key + attrStr + this.closeTag(key) + this.tagEndChar;
      }
    } else {
      let tagEndExp = "</" + key + this.tagEndChar;
      let piClosingChar = "";
      if (key[0] === "?") {
        piClosingChar = "?";
        tagEndExp = "";
      }
      if ((attrStr || attrStr === "") && val.indexOf("<") === -1) {
        return this.indentate(level) + "<" + key + attrStr + piClosingChar + ">" + val + tagEndExp;
      } else if (this.options.commentPropName !== false && key === this.options.commentPropName && piClosingChar.length === 0) {
        return this.indentate(level) + `<!--${val}-->` + this.newLine;
      } else {
        return this.indentate(level) + "<" + key + attrStr + piClosingChar + this.tagEndChar + val + this.indentate(level) + tagEndExp;
      }
    }
  };
  Builder.prototype.closeTag = function(key) {
    let closeTag = "";
    if (this.options.unpairedTags.indexOf(key) !== -1) {
      if (!this.options.suppressUnpairedNode) closeTag = "/";
    } else if (this.options.suppressEmptyNode) {
      closeTag = "/";
    } else {
      closeTag = `></${key}`;
    }
    return closeTag;
  };
  Builder.prototype.buildTextValNode = function(val, key, attrStr, level) {
    if (this.options.cdataPropName !== false && key === this.options.cdataPropName) {
      return this.indentate(level) + `<![CDATA[${val}]]>` + this.newLine;
    } else if (this.options.commentPropName !== false && key === this.options.commentPropName) {
      return this.indentate(level) + `<!--${val}-->` + this.newLine;
    } else if (key[0] === "?") {
      return this.indentate(level) + "<" + key + attrStr + "?" + this.tagEndChar;
    } else {
      let textValue = this.options.tagValueProcessor(key, val);
      textValue = this.replaceEntitiesValue(textValue);
      if (textValue === "") {
        return this.indentate(level) + "<" + key + attrStr + this.closeTag(key) + this.tagEndChar;
      } else {
        return this.indentate(level) + "<" + key + attrStr + ">" + textValue + "</" + key + this.tagEndChar;
      }
    }
  };
  Builder.prototype.replaceEntitiesValue = function(textValue) {
    if (textValue && textValue.length > 0 && this.options.processEntities) {
      for (let i = 0; i < this.options.entities.length; i++) {
        const entity = this.options.entities[i];
        textValue = textValue.replace(entity.regex, entity.val);
      }
    }
    return textValue;
  };
  function indentate(level) {
    return this.options.indentBy.repeat(level);
  }
  function isAttribute(name) {
    if (name.startsWith(this.options.attributeNamePrefix) && name !== this.options.textNodeName) {
      return name.substr(this.attrPrefixLen);
    } else {
      return false;
    }
  }
  json2xml = Builder;
  return json2xml;
}
var fxp;
var hasRequiredFxp;
function requireFxp() {
  if (hasRequiredFxp) return fxp;
  hasRequiredFxp = 1;
  const validator2 = requireValidator();
  const XMLParser = requireXMLParser();
  const XMLBuilder = requireJson2xml();
  fxp = {
    XMLParser,
    XMLValidator: validator2,
    XMLBuilder
  };
  return fxp;
}
var fxpExports = requireFxp();
const parser = new fxpExports.XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false
});
function tagOf(node) {
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text")
      return key;
  }
  return void 0;
}
function childrenOf(node) {
  const tag = tagOf(node);
  const kids = tag ? node[tag] : void 0;
  return Array.isArray(kids) ? kids : [];
}
function attrsOf(node) {
  return node[":@"] ?? {};
}
function textContent(node) {
  let out = "";
  for (const child of childrenOf(node)) {
    if ("#text" in child)
      out += String(child["#text"]);
  }
  return out;
}
function findChild(nodes, tag) {
  return nodes.find((n) => tagOf(n) === tag);
}
function parseDocx(data) {
  const files = fflate.unzipSync(data);
  const documentXml = files["word/document.xml"];
  if (!documentXml) {
    throw new Error("Not a valid .docx file: missing word/document.xml");
  }
  const root = parser.parse(fflate.strFromU8(documentXml));
  const document = findChild(root, "w:document");
  if (!document)
    throw new Error("Invalid OOXML: missing w:document");
  const body = findChild(childrenOf(document), "w:body");
  if (!body)
    throw new Error("Invalid OOXML: missing w:body");
  return { kind: "text", blocks: blocksFromBody(childrenOf(body)) };
}
function blocksFromBody(nodes) {
  const blocks = [];
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "w:p") {
      blocks.push(parseParagraph(node));
    } else if (tag === "w:tbl") {
      blocks.push(parseTable(node));
    }
  }
  return blocks;
}
function parseParagraph(p) {
  const block = { type: "paragraph", text: "" };
  const pPr = findChild(childrenOf(p), "w:pPr");
  if (pPr) {
    const pPrKids = childrenOf(pPr);
    const styleNode = findChild(pPrKids, "w:pStyle");
    if (styleNode) {
      const val = attrsOf(styleNode)["@_w:val"];
      if (val)
        block.style = val;
    }
    const numPr = findChild(pPrKids, "w:numPr");
    if (numPr) {
      const numKids = childrenOf(numPr);
      const numId = numPr && findChild(numKids, "w:numId");
      const ilvl = findChild(numKids, "w:ilvl");
      if (numId) {
        block.numbering = {
          numId: attrsOf(numId)["@_w:val"] ?? "0",
          level: Number(ilvl ? attrsOf(ilvl)["@_w:val"] ?? "0" : "0")
        };
      }
    }
  }
  block.text = collectRunText(childrenOf(p));
  return block;
}
function collectRunText(nodes) {
  let text = "";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag)
      continue;
    switch (tag) {
      case "w:pPr":
      case "w:del":
      case "w:delText":
        break;
      case "w:t":
        text += textContent(node);
        break;
      case "w:tab":
        text += "	";
        break;
      case "w:br":
      case "w:cr":
        text += "\n";
        break;
      default:
        text += collectRunText(childrenOf(node));
    }
  }
  return text;
}
function parseTable(tbl) {
  const rows = [];
  for (const rowNode of childrenOf(tbl)) {
    if (tagOf(rowNode) !== "w:tr")
      continue;
    const cells = [];
    for (const cellNode of childrenOf(rowNode)) {
      if (tagOf(cellNode) !== "w:tc")
        continue;
      const cellParagraphs = [];
      for (const inner of childrenOf(cellNode)) {
        const innerTag = tagOf(inner);
        if (innerTag === "w:p") {
          cellParagraphs.push(parseParagraph(inner).text);
        } else if (innerTag === "w:tbl") {
          const nested = parseTable(inner);
          if (nested.type === "table") {
            cellParagraphs.push(nested.rows.map((r) => r.join(" | ")).join("\n"));
          }
        }
      }
      cells.push(cellParagraphs.join("\n"));
    }
    rows.push(cells);
  }
  return { type: "table", rows };
}
const BRANCH_COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#8b5cf6",
  "#ef4444",
  "#84cc16"
];
function sha256(data) {
  return node_crypto.createHash("sha256").update(data).digest("hex");
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
class SnapshotStore {
  db;
  constructor(dbPath) {
    node_fs.mkdirSync(node_path.dirname(node_path.resolve(dbPath)), { recursive: true });
    this.db = new node_sqlite.DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id                TEXT PRIMARY KEY,
        path              TEXT NOT NULL UNIQUE,
        name              TEXT NOT NULL,
        current_branch_id TEXT,
        created_at        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branches (
        id             TEXT PRIMARY KEY,
        document_id    TEXT NOT NULL REFERENCES documents(id),
        name           TEXT NOT NULL,
        color          TEXT NOT NULL,
        head_commit_id TEXT,
        archived       INTEGER NOT NULL DEFAULT 0,
        position       INTEGER NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS objects (
        hash TEXT PRIMARY KEY,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commits (
        id          TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        branch_id   TEXT NOT NULL REFERENCES branches(id),
        parent_id   TEXT REFERENCES commits(id),
        model_hash  TEXT NOT NULL REFERENCES objects(hash),
        file_hash   TEXT NOT NULL REFERENCES objects(hash),
        message     TEXT,
        author      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sends (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_id TEXT NOT NULL REFERENCES commits(id),
        recipient TEXT NOT NULL,
        channel   TEXT,
        note      TEXT,
        sent_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_commits_document ON commits(document_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_branches_document ON branches(document_id, position);
      CREATE INDEX IF NOT EXISTS idx_sends_commit ON sends(commit_id);
      PRAGMA user_version = 2;
    `);
  }
  close() {
    this.db.close();
  }
  // ── Documents ──────────────────────────────────────────────────────────
  /** Register a document for tracking (idempotent). Creates its Main branch. */
  addDocument(filePath) {
    const path = node_path.resolve(filePath);
    const existing = this.db.prepare("SELECT * FROM documents WHERE path = ?").get(path);
    if (existing)
      return rowToDocument(existing);
    const docId = sha256(path).slice(0, 16);
    const branchId = sha256(`${docId}:main:${nowIso()}`).slice(0, 16);
    const name = path.split("/").pop() ?? path;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO documents (id, path, name, current_branch_id, created_at) VALUES (?, ?, ?, ?, ?)").run(docId, path, name, branchId, nowIso());
      this.db.prepare("INSERT INTO branches (id, document_id, name, color, head_commit_id, archived, position, created_at) VALUES (?, ?, ?, ?, NULL, 0, 0, ?)").run(branchId, docId, "Main", BRANCH_COLORS[0], nowIso());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getDocument(docId);
  }
  getDocument(id) {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    if (!row)
      throw new Error(`No document ${id}`);
    return rowToDocument(row);
  }
  getDocumentByPath(filePath) {
    const row = this.db.prepare("SELECT * FROM documents WHERE path = ?").get(node_path.resolve(filePath));
    return row ? rowToDocument(row) : void 0;
  }
  listDocuments() {
    const rows = this.db.prepare(`SELECT d.*,
                (SELECT COUNT(*) FROM commits c WHERE c.document_id = d.id) AS version_count,
                (SELECT MAX(c.created_at) FROM commits c WHERE c.document_id = d.id) AS last_version_at,
                (SELECT COUNT(*) FROM branches b WHERE b.document_id = d.id AND b.archived = 0) AS branch_count
         FROM documents d ORDER BY d.created_at`).all();
    return rows.map((row) => ({
      ...rowToDocument(row),
      versionCount: Number(row.version_count),
      lastVersionAt: row.last_version_at,
      branchCount: Number(row.branch_count)
    }));
  }
  // ── Commits ────────────────────────────────────────────────────────────
  /**
   * Snapshot a document onto its current branch. Content identical to the
   * branch head is a no-op (`created: false`).
   *
   * With `coalesceWindowMs`, a burst of saves merges into one rolling
   * version: if the branch head has the same message, is younger than the
   * window, and nothing observable depends on it (no sends, no children, no
   * branch forked there), the head is *replaced* instead of extended — so a
   * Word work session yields one version, not one per ⌘S.
   */
  commit(filePath, fileBytes, model, opts = {}) {
    const doc = this.addDocument(filePath);
    const branch = this.getBranch(doc.currentBranchId);
    const modelJson = canonicalJson(model);
    const modelHash = sha256(modelJson);
    const head = branch.headCommitId ? this.getCommit(branch.headCommitId) : void 0;
    if (head && head.modelHash === modelHash) {
      return { commit: head, created: false };
    }
    const fileHash = sha256(fileBytes);
    const payload = {
      modelHash,
      modelJson,
      fileHash,
      fileBytes,
      message: opts.message ?? null,
      author: opts.author ?? null
    };
    if (head && opts.coalesceWindowMs !== void 0 && this.canCoalesce(head, payload.message, opts.coalesceWindowMs)) {
      return { commit: this.replaceCommit(head, payload), created: true };
    }
    return {
      commit: this.insertCommit(doc.id, branch.id, head?.id ?? null, payload),
      created: true
    };
  }
  /** A head can be coalesced only when nothing observable depends on it. */
  canCoalesce(head, message, windowMs) {
    if (head.message !== message)
      return false;
    if (Date.now() - Date.parse(head.createdAt) > windowMs)
      return false;
    const sends = this.db.prepare("SELECT COUNT(*) AS n FROM sends WHERE commit_id = ?").get(head.id);
    if (Number(sends.n) > 0)
      return false;
    const children = this.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE parent_id = ?").get(head.id);
    if (Number(children.n) > 0)
      return false;
    const forks = this.db.prepare("SELECT COUNT(*) AS n FROM branches WHERE head_commit_id = ? AND id != ?").get(head.id, head.branchId);
    return Number(forks.n) === 0;
  }
  /** Swap the branch head for a fresh commit with the same parent — the coalesce primitive. */
  replaceCommit(head, data) {
    const createdAt = nowIso();
    const id = sha256(JSON.stringify([head.documentId, head.branchId, head.parentId, data.modelHash, data.fileHash, data.message, createdAt]));
    this.db.exec("BEGIN");
    try {
      this.putObject(data.modelHash, Buffer.from(data.modelJson, "utf8"));
      this.putObject(data.fileHash, Buffer.from(data.fileBytes));
      this.db.prepare(`INSERT INTO commits (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, head.documentId, head.branchId, head.parentId, data.modelHash, data.fileHash, data.message, data.author, createdAt);
      this.db.prepare("UPDATE branches SET head_commit_id = ? WHERE id = ?").run(id, head.branchId);
      this.db.prepare("DELETE FROM commits WHERE id = ?").run(head.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getCommit(id);
  }
  /**
   * Re-commit the content of an old version onto the current branch
   * ("restore"). Object blobs are reused — only a new commit row is created.
   */
  restoreVersion(documentId, commitId, message) {
    const doc = this.getDocument(documentId);
    const source = this.getCommit(commitId);
    const branch = this.getBranch(doc.currentBranchId);
    const head = branch.headCommitId ? this.getCommit(branch.headCommitId) : void 0;
    if (head && head.modelHash === source.modelHash) {
      return { commit: head, created: false };
    }
    return {
      commit: this.insertCommit(doc.id, branch.id, head?.id ?? null, {
        modelHash: source.modelHash,
        fileHash: source.fileHash,
        message: message ?? `Restored version from ${source.createdAt.slice(0, 10)}`,
        author: null
      }),
      created: true
    };
  }
  insertCommit(documentId, branchId, parentId, data) {
    const createdAt = nowIso();
    const id = sha256(JSON.stringify([documentId, branchId, parentId, data.modelHash, data.fileHash, data.message, createdAt]));
    this.db.exec("BEGIN");
    try {
      if (data.modelJson !== void 0)
        this.putObject(data.modelHash, Buffer.from(data.modelJson, "utf8"));
      if (data.fileBytes !== void 0)
        this.putObject(data.fileHash, Buffer.from(data.fileBytes));
      this.db.prepare(`INSERT INTO commits (id, document_id, branch_id, parent_id, model_hash, file_hash, message, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, documentId, branchId, parentId, data.modelHash, data.fileHash, data.message, data.author, createdAt);
      this.db.prepare("UPDATE branches SET head_commit_id = ? WHERE id = ?").run(id, branchId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getCommit(id);
  }
  /** Commit history for a document across all branches, newest first. */
  log(filePath) {
    const doc = this.getDocumentByPath(filePath);
    if (!doc)
      return [];
    return this.db.prepare("SELECT * FROM commits WHERE document_id = ? ORDER BY created_at DESC, rowid DESC").all(doc.id).map(rowToCommit);
  }
  /** Resolve a (possibly abbreviated) commit id. Throws if ambiguous or unknown. */
  resolve(ref) {
    const rows = this.db.prepare("SELECT * FROM commits WHERE id LIKE ? LIMIT 2").all(`${ref}%`);
    if (rows.length === 0)
      throw new Error(`No commit matches "${ref}"`);
    if (rows.length > 1)
      throw new Error(`Commit ref "${ref}" is ambiguous`);
    return rowToCommit(rows[0]);
  }
  getCommit(id) {
    const row = this.db.prepare("SELECT * FROM commits WHERE id = ?").get(id);
    if (!row)
      throw new Error(`No commit ${id}`);
    return rowToCommit(row);
  }
  getModel(commit) {
    return JSON.parse(Buffer.from(this.getObject(commit.modelHash)).toString("utf8"));
  }
  getFileBytes(commit) {
    return this.getObject(commit.fileHash);
  }
  /**
   * How far a commit's own branch has advanced past it: the number of commits
   * between the branch head and this commit. 0 means it is the head; null
   * means the commit is no longer reachable from its branch head.
   */
  divergence(commitId) {
    const commit = this.getCommit(commitId);
    const branch = this.getBranch(commit.branchId);
    let cursor = branch.headCommitId;
    let count = 0;
    while (cursor) {
      if (cursor === commitId)
        return count;
      const row = this.db.prepare("SELECT parent_id FROM commits WHERE id = ?").get(cursor);
      if (!row)
        return null;
      cursor = row.parent_id;
      count++;
    }
    return null;
  }
  // ── Branches ───────────────────────────────────────────────────────────
  getBranch(id) {
    const row = this.db.prepare("SELECT * FROM branches WHERE id = ?").get(id);
    if (!row)
      throw new Error(`No branch ${id}`);
    return rowToBranch(row);
  }
  listBranches(documentId) {
    return this.db.prepare("SELECT * FROM branches WHERE document_id = ? ORDER BY position").all(documentId).map(rowToBranch);
  }
  /** Branch off any commit; the new branch becomes the document's current branch. */
  createBranch(documentId, name, fromCommitId, color) {
    const doc = this.getDocument(documentId);
    const from = this.getCommit(fromCommitId);
    if (from.documentId !== doc.id)
      throw new Error("Cannot branch from another document");
    const siblings = this.listBranches(documentId);
    const position = siblings.length === 0 ? 0 : Math.max(...siblings.map((b) => b.position)) + 1;
    const id = sha256(`${documentId}:${name}:${nowIso()}`).slice(0, 16);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO branches (id, document_id, name, color, head_commit_id, archived, position, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)").run(id, documentId, name, color ?? BRANCH_COLORS[position % BRANCH_COLORS.length], fromCommitId, position, nowIso());
      this.db.prepare("UPDATE documents SET current_branch_id = ? WHERE id = ?").run(id, documentId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getBranch(id);
  }
  /** Make a branch current. The caller is responsible for syncing the file on disk to the branch head. */
  switchBranch(documentId, branchId) {
    const branch = this.getBranch(branchId);
    if (branch.documentId !== documentId)
      throw new Error("Branch belongs to another document");
    this.db.prepare("UPDATE documents SET current_branch_id = ? WHERE id = ?").run(branchId, documentId);
    return branch;
  }
  renameBranch(branchId, name) {
    this.db.prepare("UPDATE branches SET name = ? WHERE id = ?").run(name, branchId);
    return this.getBranch(branchId);
  }
  setBranchColor(branchId, color) {
    this.db.prepare("UPDATE branches SET color = ? WHERE id = ?").run(color, branchId);
    return this.getBranch(branchId);
  }
  setBranchArchived(branchId, archived) {
    const branch = this.getBranch(branchId);
    const doc = this.getDocument(branch.documentId);
    if (archived && doc.currentBranchId === branchId) {
      throw new Error("Cannot archive the current branch");
    }
    this.db.prepare("UPDATE branches SET archived = ? WHERE id = ?").run(archived ? 1 : 0, branchId);
    return this.getBranch(branchId);
  }
  // ── Sends ──────────────────────────────────────────────────────────────
  markSent(commitId, info) {
    this.getCommit(commitId);
    const result = this.db.prepare("INSERT INTO sends (commit_id, recipient, channel, note, sent_at) VALUES (?, ?, ?, ?, ?)").run(commitId, info.recipient, info.channel ?? null, info.note ?? null, info.sentAt ?? nowIso());
    const row = this.db.prepare("SELECT * FROM sends WHERE id = ?").get(Number(result.lastInsertRowid));
    return rowToSend(row);
  }
  sendsForDocument(documentId) {
    return this.db.prepare("SELECT s.* FROM sends s JOIN commits c ON c.id = s.commit_id WHERE c.document_id = ? ORDER BY s.sent_at").all(documentId).map(rowToSend);
  }
  // ── Graph ──────────────────────────────────────────────────────────────
  /** Everything the tree view needs in one call. */
  graph(documentId) {
    const document = this.getDocument(documentId);
    return {
      document,
      branches: this.listBranches(documentId),
      commits: this.db.prepare("SELECT * FROM commits WHERE document_id = ? ORDER BY created_at, rowid").all(documentId).map(rowToCommit),
      sends: this.sendsForDocument(documentId)
    };
  }
  // ── Objects ────────────────────────────────────────────────────────────
  getObject(hash) {
    const row = this.db.prepare("SELECT data FROM objects WHERE hash = ?").get(hash);
    if (!row)
      throw new Error(`Missing object ${hash}`);
    return row.data;
  }
  putObject(hash, data) {
    this.db.prepare("INSERT OR IGNORE INTO objects (hash, data) VALUES (?, ?)").run(hash, data);
  }
}
function rowToDocument(row) {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    currentBranchId: row.current_branch_id,
    createdAt: row.created_at
  };
}
function rowToBranch(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    color: row.color,
    headCommitId: row.head_commit_id,
    archived: row.archived !== 0,
    position: Number(row.position),
    createdAt: row.created_at
  };
}
function rowToCommit(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    branchId: row.branch_id,
    parentId: row.parent_id,
    modelHash: row.model_hash,
    fileHash: row.file_hash,
    message: row.message,
    author: row.author,
    createdAt: row.created_at
  };
}
function rowToSend(row) {
  return {
    id: Number(row.id),
    commitId: row.commit_id,
    recipient: row.recipient,
    channel: row.channel,
    note: row.note,
    sentAt: row.sent_at
  };
}
class Diff {
  diff(oldStr, newStr, options = {}) {
    let callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if ("callback" in options) {
      callback = options.callback;
    }
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);
    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));
    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }
  diffWithOptionsObj(oldTokens, newTokens, options, callback) {
    var _a;
    const done = (value) => {
      value = this.postProcess(value, options);
      if (callback) {
        setTimeout(function() {
          callback(value);
        }, 0);
        return void 0;
      } else {
        return value;
      }
    };
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if (options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;
    const bestPath = [{ oldPos: -1, lastComponent: void 0 }];
    let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
    }
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    const execEditLength = () => {
      for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        let basePath;
        const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = void 0;
        }
        let canAdd = false;
        if (addPath) {
          const addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = void 0;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }
        newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    };
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback(void 0);
          }
          if (!execEditLength()) {
            exec();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  }
  addToPath(path, added, removed, oldPosInc, options) {
    const last = path.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: 1, added, removed, previousComponent: last }
      };
    }
  }
  extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
    }
    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
    }
    basePath.oldPos = oldPos;
    return newPos;
  }
  equals(left, right, options) {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  }
  removeEmpty(array) {
    const ret = [];
    for (let i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  castInput(value, options) {
    return value;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(value, options) {
    return Array.from(value);
  }
  join(chars) {
    return chars.join("");
  }
  postProcess(changeObjects, options) {
    return changeObjects;
  }
  get useLongestToken() {
    return false;
  }
  buildValues(lastComponent, newTokens, oldTokens) {
    const components = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();
    const componentLen = components.length;
    let componentPos = 0, newPos = 0, oldPos = 0;
    for (; componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value2, i) {
            const oldValue = oldTokens[oldPos + i];
            return oldValue.length > value2.length ? oldValue : value2;
          });
          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }
    return components;
  }
}
function longestCommonPrefix(str1, str2) {
  let i;
  for (i = 0; i < str1.length && i < str2.length; i++) {
    if (str1[i] != str2[i]) {
      return str1.slice(0, i);
    }
  }
  return str1.slice(0, i);
}
function longestCommonSuffix(str1, str2) {
  let i;
  if (!str1 || !str2 || str1[str1.length - 1] != str2[str2.length - 1]) {
    return "";
  }
  for (i = 0; i < str1.length && i < str2.length; i++) {
    if (str1[str1.length - (i + 1)] != str2[str2.length - (i + 1)]) {
      return str1.slice(-i);
    }
  }
  return str1.slice(-i);
}
function replacePrefix(string, oldPrefix, newPrefix) {
  if (string.slice(0, oldPrefix.length) != oldPrefix) {
    throw Error(`string ${JSON.stringify(string)} doesn't start with prefix ${JSON.stringify(oldPrefix)}; this is a bug`);
  }
  return newPrefix + string.slice(oldPrefix.length);
}
function replaceSuffix(string, oldSuffix, newSuffix) {
  if (!oldSuffix) {
    return string + newSuffix;
  }
  if (string.slice(-oldSuffix.length) != oldSuffix) {
    throw Error(`string ${JSON.stringify(string)} doesn't end with suffix ${JSON.stringify(oldSuffix)}; this is a bug`);
  }
  return string.slice(0, -oldSuffix.length) + newSuffix;
}
function removePrefix(string, oldPrefix) {
  return replacePrefix(string, oldPrefix, "");
}
function removeSuffix(string, oldSuffix) {
  return replaceSuffix(string, oldSuffix, "");
}
function maximumOverlap(string1, string2) {
  return string2.slice(0, overlapCount(string1, string2));
}
function overlapCount(a, b) {
  let startA = 0;
  if (a.length > b.length) {
    startA = a.length - b.length;
  }
  let endB = b.length;
  if (a.length < b.length) {
    endB = a.length;
  }
  const map = Array(endB);
  let k = 0;
  map[0] = 0;
  for (let j = 1; j < endB; j++) {
    if (b[j] == b[k]) {
      map[j] = map[k];
    } else {
      map[j] = k;
    }
    while (k > 0 && b[j] != b[k]) {
      k = map[k];
    }
    if (b[j] == b[k]) {
      k++;
    }
  }
  k = 0;
  for (let i = startA; i < a.length; i++) {
    while (k > 0 && a[i] != b[k]) {
      k = map[k];
    }
    if (a[i] == b[k]) {
      k++;
    }
  }
  return k;
}
function segment(string, segmenter) {
  const parts = [];
  for (const segmentObj of Array.from(segmenter.segment(string))) {
    const segment2 = segmentObj.segment;
    if (parts.length && /\s/.test(parts[parts.length - 1]) && /\s/.test(segment2)) {
      parts[parts.length - 1] += segment2;
    } else {
      parts.push(segment2);
    }
  }
  return parts;
}
function trailingWs(string, segmenter) {
  if (segmenter) {
    return leadingAndTrailingWs(string, segmenter)[1];
  }
  let i;
  for (i = string.length - 1; i >= 0; i--) {
    if (!string[i].match(/\s/)) {
      break;
    }
  }
  return string.substring(i + 1);
}
function leadingWs(string, segmenter) {
  if (segmenter) {
    return leadingAndTrailingWs(string, segmenter)[0];
  }
  const match = string.match(/^\s*/);
  return match ? match[0] : "";
}
function leadingAndTrailingWs(string, segmenter) {
  if (!segmenter) {
    return [leadingWs(string), trailingWs(string)];
  }
  if (segmenter.resolvedOptions().granularity != "word") {
    throw new Error('The segmenter passed must have a granularity of "word"');
  }
  const segments = segment(string, segmenter);
  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];
  const head = /\s/.test(firstSeg) ? firstSeg : "";
  const tail = /\s/.test(lastSeg) ? lastSeg : "";
  return [head, tail];
}
const extendedWordChars = "a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";
const tokenizeIncludingWhitespace = new RegExp(`[${extendedWordChars}]+|\\s+|[^${extendedWordChars}]`, "ug");
class WordDiff extends Diff {
  equals(left, right, options) {
    if (options.ignoreCase) {
      left = left.toLowerCase();
      right = right.toLowerCase();
    }
    return left.trim() === right.trim();
  }
  tokenize(value, options = {}) {
    let parts;
    if (options.intlSegmenter) {
      const segmenter = options.intlSegmenter;
      if (segmenter.resolvedOptions().granularity != "word") {
        throw new Error('The segmenter passed must have a granularity of "word"');
      }
      parts = segment(value, segmenter);
    } else {
      parts = value.match(tokenizeIncludingWhitespace) || [];
    }
    const tokens = [];
    let prevPart = null;
    parts.forEach((part) => {
      if (/\s/.test(part)) {
        if (prevPart == null) {
          tokens.push(part);
        } else {
          tokens.push(tokens.pop() + part);
        }
      } else if (prevPart != null && /\s/.test(prevPart)) {
        if (tokens[tokens.length - 1] == prevPart) {
          tokens.push(tokens.pop() + part);
        } else {
          tokens.push(prevPart + part);
        }
      } else {
        tokens.push(part);
      }
      prevPart = part;
    });
    return tokens;
  }
  join(tokens) {
    return tokens.map((token, i) => {
      if (i == 0) {
        return token;
      } else {
        return token.replace(/^\s+/, "");
      }
    }).join("");
  }
  postProcess(changes, options) {
    if (!changes || options.oneChangePerToken) {
      return changes;
    }
    let lastKeep = null;
    let insertion = null;
    let deletion = null;
    changes.forEach((change) => {
      if (change.added) {
        insertion = change;
      } else if (change.removed) {
        deletion = change;
      } else {
        if (insertion || deletion) {
          dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, change, options.intlSegmenter);
        }
        lastKeep = change;
        insertion = null;
        deletion = null;
      }
    });
    if (insertion || deletion) {
      dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, null, options.intlSegmenter);
    }
    return changes;
  }
}
const wordDiff = new WordDiff();
function diffWords(oldStr, newStr, options) {
  return wordDiff.diff(oldStr, newStr, options);
}
function dedupeWhitespaceInChangeObjects(startKeep, deletion, insertion, endKeep, segmenter) {
  if (deletion && insertion) {
    const [oldWsPrefix, oldWsSuffix] = leadingAndTrailingWs(deletion.value, segmenter);
    const [newWsPrefix, newWsSuffix] = leadingAndTrailingWs(insertion.value, segmenter);
    if (startKeep) {
      const commonWsPrefix = longestCommonPrefix(oldWsPrefix, newWsPrefix);
      startKeep.value = replaceSuffix(startKeep.value, newWsPrefix, commonWsPrefix);
      deletion.value = removePrefix(deletion.value, commonWsPrefix);
      insertion.value = removePrefix(insertion.value, commonWsPrefix);
    }
    if (endKeep) {
      const commonWsSuffix = longestCommonSuffix(oldWsSuffix, newWsSuffix);
      endKeep.value = replacePrefix(endKeep.value, newWsSuffix, commonWsSuffix);
      deletion.value = removeSuffix(deletion.value, commonWsSuffix);
      insertion.value = removeSuffix(insertion.value, commonWsSuffix);
    }
  } else if (insertion) {
    if (startKeep) {
      const ws = leadingWs(insertion.value, segmenter);
      insertion.value = insertion.value.substring(ws.length);
    }
    if (endKeep) {
      const ws = leadingWs(endKeep.value, segmenter);
      endKeep.value = endKeep.value.substring(ws.length);
    }
  } else if (startKeep && endKeep) {
    const newWsFull = leadingWs(endKeep.value, segmenter), [delWsStart, delWsEnd] = leadingAndTrailingWs(deletion.value, segmenter);
    const newWsStart = longestCommonPrefix(newWsFull, delWsStart);
    deletion.value = removePrefix(deletion.value, newWsStart);
    const newWsEnd = longestCommonSuffix(removePrefix(newWsFull, newWsStart), delWsEnd);
    deletion.value = removeSuffix(deletion.value, newWsEnd);
    endKeep.value = replacePrefix(endKeep.value, newWsFull, newWsEnd);
    startKeep.value = replaceSuffix(startKeep.value, newWsFull, newWsFull.slice(0, newWsFull.length - newWsEnd.length));
  } else if (endKeep) {
    const endKeepWsPrefix = leadingWs(endKeep.value, segmenter);
    const deletionWsSuffix = trailingWs(deletion.value, segmenter);
    const overlap = maximumOverlap(deletionWsSuffix, endKeepWsPrefix);
    deletion.value = removeSuffix(deletion.value, overlap);
  } else if (startKeep) {
    const startKeepWsSuffix = trailingWs(startKeep.value, segmenter);
    const deletionWsPrefix = leadingWs(deletion.value, segmenter);
    const overlap = maximumOverlap(startKeepWsSuffix, deletionWsPrefix);
    deletion.value = removePrefix(deletion.value, overlap);
  }
}
class ArrayDiff extends Diff {
  tokenize(value) {
    return value.slice();
  }
  join(value) {
    return value;
  }
  removeEmpty(value) {
    return value;
  }
}
const arrayDiff = new ArrayDiff();
function diffArrays(oldArr, newArr, options) {
  return arrayDiff.diff(oldArr, newArr, options);
}
const MODIFIED_THRESHOLD = 0.4;
function diffModels(oldModel, newModel) {
  const oldBlocks = oldModel.blocks;
  const newBlocks = newModel.blocks;
  const oldKeys = oldBlocks.map(blockText);
  const newKeys = newBlocks.map(blockText);
  const parts = diffArrays(oldKeys, newKeys);
  const changes = [];
  let oldIdx = 0;
  let newIdx = 0;
  let pendingRemoved = [];
  const flushPending = (addedRun) => {
    changes.push(...pairHunk(pendingRemoved, addedRun));
    pendingRemoved = [];
  };
  for (const part of parts) {
    if (part.removed) {
      for (const _ of part.value) {
        pendingRemoved.push({
          type: "removed",
          oldIndex: oldIdx,
          oldBlock: oldBlocks[oldIdx]
        });
        oldIdx++;
      }
    } else if (part.added) {
      const addedRun = [];
      for (const _ of part.value) {
        addedRun.push({
          type: "added",
          newIndex: newIdx,
          newBlock: newBlocks[newIdx]
        });
        newIdx++;
      }
      flushPending(addedRun);
    } else {
      flushPending([]);
      for (const _ of part.value) {
        changes.push({
          type: "unchanged",
          oldIndex: oldIdx,
          newIndex: newIdx,
          oldBlock: oldBlocks[oldIdx],
          newBlock: newBlocks[newIdx]
        });
        oldIdx++;
        newIdx++;
      }
    }
  }
  flushPending([]);
  detectMoves(changes);
  detectFormattingChanges(changes);
  return { changes, summary: summarize(changes) };
}
function detectFormattingChanges(changes) {
  for (const change of changes) {
    const { oldBlock, newBlock } = change;
    if (!oldBlock || !newBlock || oldBlock.type !== "paragraph" || newBlock.type !== "paragraph")
      continue;
    const styleChanged = (oldBlock.style ?? "") !== (newBlock.style ?? "");
    const numberingChanged = JSON.stringify(oldBlock.numbering ?? null) !== JSON.stringify(newBlock.numbering ?? null);
    if (styleChanged || numberingChanged) {
      change.formatting = {
        ...styleChanged ? { fromStyle: oldBlock.style, toStyle: newBlock.style } : {},
        ...numberingChanged ? { numberingChanged: true } : {}
      };
    }
  }
}
function pairHunk(removed, added) {
  if (removed.length === 0 || added.length === 0)
    return [...removed, ...added];
  const matchedAdded = /* @__PURE__ */ new Set();
  const result = [];
  for (const rem of removed) {
    const remText = blockText(rem.oldBlock);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < added.length; i++) {
      if (matchedAdded.has(i))
        continue;
      const score = similarity(remText, blockText(added[i].newBlock));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= MODIFIED_THRESHOLD) {
      matchedAdded.add(best);
      const add = added[best];
      result.push({
        type: "modified",
        oldIndex: rem.oldIndex,
        newIndex: add.newIndex,
        oldBlock: rem.oldBlock,
        newBlock: add.newBlock,
        spans: wordSpans(remText, blockText(add.newBlock))
      });
    } else {
      result.push(rem);
    }
  }
  for (let i = 0; i < added.length; i++) {
    if (!matchedAdded.has(i))
      result.push(added[i]);
  }
  return result;
}
function detectMoves(changes) {
  const removedByText = /* @__PURE__ */ new Map();
  for (const change of changes) {
    if (change.type !== "removed")
      continue;
    const text = blockText(change.oldBlock);
    if (text.trim() === "")
      continue;
    const list = removedByText.get(text);
    if (list)
      list.push(change);
    else
      removedByText.set(text, [change]);
  }
  if (removedByText.size === 0)
    return;
  const toDrop = /* @__PURE__ */ new Set();
  for (const change of changes) {
    if (change.type !== "added")
      continue;
    const text = blockText(change.newBlock);
    const candidates = removedByText.get(text);
    const partner = candidates?.shift();
    if (!partner)
      continue;
    change.type = "moved";
    change.oldIndex = partner.oldIndex;
    change.oldBlock = partner.oldBlock;
    toDrop.add(partner);
  }
  if (toDrop.size > 0) {
    let write = 0;
    for (let read = 0; read < changes.length; read++) {
      if (!toDrop.has(changes[read]))
        changes[write++] = changes[read];
    }
    changes.length = write;
  }
}
function summarize(changes) {
  const summary = { added: 0, removed: 0, modified: 0, moved: 0, unchanged: 0, formatting: 0 };
  for (const change of changes) {
    summary[change.type]++;
    if (change.formatting)
      summary.formatting++;
  }
  return summary;
}
function similarity(a, b) {
  if (a === b)
    return 1;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 && tb.size === 0)
    return 1;
  if (ta.size === 0 || tb.size === 0)
    return 0;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token))
      intersection++;
  }
  return 2 * intersection / (ta.size + tb.size);
}
function tokenSet(text) {
  return new Set(text.toLowerCase().split(/[\s.,;:!?()[\]{}'"«»]+/).filter(Boolean));
}
function wordSpans(oldText, newText) {
  return diffWords(oldText, newText).map((part) => ({
    text: part.value,
    kind: part.added ? "added" : part.removed ? "removed" : "same"
  }));
}
const AUTOSAVE_COALESCE_MS = 15 * 6e4;
class DocumentService {
  constructor(dbPath, onChanged) {
    this.onChanged = onChanged;
    this.watchers = /* @__PURE__ */ new Map();
    this.store = new SnapshotStore(dbPath);
    for (const doc of this.store.listDocuments()) this.watch(doc);
  }
  dispose() {
    for (const watcher of this.watchers.values()) void watcher.close();
    this.watchers.clear();
    this.store.close();
  }
  // ── Documents ──────────────────────────────────────────────────────────
  listDocuments() {
    return this.store.listDocuments();
  }
  /** Track a document and snapshot its current content as the first version. */
  addDocument(path) {
    const doc = this.store.addDocument(path);
    this.commitPath(doc.path, "Added to DocGit");
    this.watch(doc);
    this.onChanged(doc.id);
    return doc;
  }
  getGraph(documentId) {
    return this.store.graph(documentId);
  }
  documentPath(documentId) {
    return this.store.getDocument(documentId).path;
  }
  // ── Versions ───────────────────────────────────────────────────────────
  saveVersion(documentId, message) {
    const doc = this.store.getDocument(documentId);
    const result = this.commitPath(doc.path, message);
    if (result?.created) this.onChanged(documentId);
    return result;
  }
  diff(fromCommitId, toCommitId) {
    const from = this.store.getCommit(fromCommitId);
    const to = this.store.getCommit(toCommitId);
    return diffModels(this.store.getModel(from), this.store.getModel(to));
  }
  commitLabel(commitId) {
    const commit = this.store.getCommit(commitId);
    const when = new Date(commit.createdAt).toLocaleString();
    return commit.message ? `${commit.message} — ${when}` : when;
  }
  divergence(commitId) {
    return this.store.divergence(commitId);
  }
  /**
   * Restore an old version: its content becomes a new version on the current
   * branch AND is written back to the file on disk.
   */
  restoreVersion(documentId, commitId) {
    const result = this.store.restoreVersion(documentId, commitId);
    if (result.created) {
      this.writeFileFromCommit(documentId, result.commit.id);
      this.onChanged(documentId);
    }
    return result;
  }
  /** Materialize an old version as a temp copy for read-only viewing. Returns the temp path. */
  exportVersion(commitId) {
    const commit = this.store.getCommit(commitId);
    const doc = this.store.getDocument(commit.documentId);
    const dir = node_path.join(node_os.tmpdir(), "docgit-versions");
    node_fs.mkdirSync(dir, { recursive: true });
    const stamp = commit.createdAt.slice(0, 16).replace(/[:T]/g, "-");
    const base = doc.name.replace(/\.docx$/i, "");
    const path = node_path.join(dir, `${base} (version ${stamp}).docx`);
    node_fs.writeFileSync(path, this.store.getFileBytes(commit));
    return path;
  }
  // ── Branches ───────────────────────────────────────────────────────────
  createBranch(documentId, name, fromCommitId) {
    const branch = this.store.createBranch(documentId, name, fromCommitId);
    this.writeFileFromCommit(documentId, fromCommitId);
    this.onChanged(documentId);
    return branch;
  }
  /** Switch the working branch and sync the file on disk to that branch's latest version. */
  switchBranch(documentId, branchId) {
    const branch = this.store.switchBranch(documentId, branchId);
    if (branch.headCommitId) this.writeFileFromCommit(documentId, branch.headCommitId);
    this.onChanged(documentId);
    return branch;
  }
  renameBranch(documentId, branchId, name) {
    const branch = this.store.renameBranch(branchId, name);
    this.onChanged(documentId);
    return branch;
  }
  setBranchColor(documentId, branchId, color) {
    const branch = this.store.setBranchColor(branchId, color);
    this.onChanged(documentId);
    return branch;
  }
  setBranchArchived(documentId, branchId, archived) {
    const branch = this.store.setBranchArchived(branchId, archived);
    this.onChanged(documentId);
    return branch;
  }
  // ── Sends ──────────────────────────────────────────────────────────────
  markSent(documentId, commitId, info) {
    const send = this.store.markSent(commitId, info);
    this.onChanged(documentId);
    return send;
  }
  // ── Internals ──────────────────────────────────────────────────────────
  commitPath(path, message, coalesceWindowMs) {
    let bytes;
    try {
      bytes = node_fs.readFileSync(path);
    } catch {
      return void 0;
    }
    try {
      const model = parseDocx(bytes);
      return this.store.commit(path, bytes, model, {
        ...message !== void 0 ? { message } : {},
        ...coalesceWindowMs !== void 0 ? { coalesceWindowMs } : {}
      });
    } catch {
      return void 0;
    }
  }
  writeFileFromCommit(documentId, commitId) {
    const doc = this.store.getDocument(documentId);
    const commit = this.store.getCommit(commitId);
    node_fs.writeFileSync(doc.path, this.store.getFileBytes(commit));
  }
  watch(doc) {
    if (this.watchers.has(doc.id)) return;
    const watcher = chokidar.watch(doc.path, {
      ignoreInitial: true,
      // Word saves via temp-file swap; wait for the write to settle.
      awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 120 }
    });
    watcher.on("add", () => this.autoCommit(doc));
    watcher.on("change", () => this.autoCommit(doc));
    this.watchers.set(doc.id, watcher);
  }
  autoCommit(doc) {
    const result = this.commitPath(doc.path, "Saved", AUTOSAVE_COALESCE_MS);
    if (result?.created) this.onChanged(doc.id);
  }
}
let service = null;
let win = null;
function notifyRenderer(documentId) {
  win?.webContents.send("docgit:changed", documentId);
}
function createWindow() {
  win = new electron.BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: "DocGit",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: "#faf7f2",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js")
    }
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
}
function registerIpc(svc) {
  electron.ipcMain.handle("docs:list", () => svc.listDocuments());
  electron.ipcMain.handle("docs:add", async () => {
    const result = await electron.dialog.showOpenDialog(win, {
      title: "Add a document to DocGit",
      filters: [{ name: "Word documents", extensions: ["docx"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return svc.addDocument(result.filePaths[0]);
  });
  electron.ipcMain.handle("docs:open", (_e, documentId) => electron.shell.openPath(svc.documentPath(documentId)));
  electron.ipcMain.handle("docs:graph", (_e, documentId) => svc.getGraph(documentId));
  electron.ipcMain.handle("version:save", (_e, documentId, message) => svc.saveVersion(documentId, message));
  electron.ipcMain.handle("version:diff", (_e, fromId, toId) => ({
    diff: svc.diff(fromId, toId),
    fromLabel: svc.commitLabel(fromId),
    toLabel: svc.commitLabel(toId)
  }));
  electron.ipcMain.handle("version:divergence", (_e, commitId) => svc.divergence(commitId));
  electron.ipcMain.handle(
    "version:restore",
    (_e, documentId, commitId) => svc.restoreVersion(documentId, commitId)
  );
  electron.ipcMain.handle("version:openCopy", async (_e, commitId) => {
    const path = svc.exportVersion(commitId);
    await electron.shell.openPath(path);
    return path;
  });
  electron.ipcMain.handle(
    "branch:create",
    (_e, documentId, name, fromCommitId) => svc.createBranch(documentId, name, fromCommitId)
  );
  electron.ipcMain.handle(
    "branch:switch",
    (_e, documentId, branchId) => svc.switchBranch(documentId, branchId)
  );
  electron.ipcMain.handle(
    "branch:rename",
    (_e, documentId, branchId, name) => svc.renameBranch(documentId, branchId, name)
  );
  electron.ipcMain.handle(
    "branch:color",
    (_e, documentId, branchId, color) => svc.setBranchColor(documentId, branchId, color)
  );
  electron.ipcMain.handle(
    "branch:archive",
    (_e, documentId, branchId, archived) => svc.setBranchArchived(documentId, branchId, archived)
  );
  electron.ipcMain.handle(
    "send:mark",
    (_e, documentId, commitId, info) => svc.markSent(documentId, commitId, info)
  );
}
async function runSmokeTest() {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { zipSync, strToU8 } = await import("fflate");
  const dir = mkdtempSync(node_path.join(tmpdir(), "docgit-electron-smoke-"));
  try {
    const makeDocx = (paras) => {
      const body = paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("");
      return zipSync({
        "[Content_Types].xml": strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
        ),
        "word/document.xml": strToU8(
          `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
        )
      });
    };
    const docPath = node_path.join(dir, "smoke.docx");
    writeFileSync(docPath, makeDocx(["Clause one.", "Clause two."]));
    const events = [];
    const svc = new DocumentService(node_path.join(dir, "docgit.db"), (id) => events.push(id));
    const doc = svc.addDocument(docPath);
    writeFileSync(docPath, makeDocx(["Clause one, amended.", "Clause two.", "Clause three."]));
    const v2 = svc.saveVersion(doc.id, "amendments");
    const graph = svc.getGraph(doc.id);
    if (graph.commits.length !== 2) throw new Error(`expected 2 commits, got ${graph.commits.length}`);
    const diff = svc.diff(graph.commits[0].id, graph.commits[1].id);
    if (diff.summary.modified !== 1 || diff.summary.added !== 1) {
      throw new Error(`unexpected diff summary: ${JSON.stringify(diff.summary)}`);
    }
    const branch = svc.createBranch(doc.id, "Client B variant", graph.commits[0].id);
    svc.markSent(doc.id, v2.commit.id, { recipient: "Acme", channel: "email" });
    const after = svc.getGraph(doc.id);
    if (after.branches.length !== 2) throw new Error("branch not created");
    if (after.sends.length !== 1) throw new Error("send not recorded");
    if (after.document.currentBranchId !== branch.id) throw new Error("branch not current");
    svc.dispose();
    console.log("SMOKE OK: electron", process.versions.electron, "/ node", process.versions.node);
    electron.app.exit(0);
  } catch (err) {
    console.error("SMOKE FAILED:", err);
    electron.app.exit(1);
  }
}
async function runBootCheck() {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(node_path.join(tmpdir(), "docgit-bootcheck-"));
  const errors = [];
  service = new DocumentService(node_path.join(dir, "docgit.db"), notifyRenderer);
  registerIpc(service);
  const hidden = new electron.BrowserWindow({
    show: false,
    webPreferences: { preload: node_path.join(__dirname, "../preload/index.js") }
  });
  win = hidden;
  hidden.webContents.on("console-message", (...args) => {
    const detail = args[1];
    const level = typeof detail === "object" && detail !== null ? detail.level : args[1];
    if (level === "error" || level === 3) errors.push(JSON.stringify(args.slice(1)));
  });
  hidden.webContents.on("render-process-gone", (_e, details) => {
    errors.push(`renderer gone: ${details.reason}`);
  });
  try {
    await hidden.loadFile(node_path.join(__dirname, "../renderer/index.html"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (errors.length > 0) throw new Error(errors.join("\n"));
    console.log("BOOT CHECK OK: renderer loaded cleanly");
    electron.app.exit(0);
  } catch (err) {
    console.error("BOOT CHECK FAILED:", err);
    electron.app.exit(1);
  }
}
void electron.app.whenReady().then(() => {
  if (process.env["DOCGIT_SMOKE"] === "1") {
    void runSmokeTest();
    return;
  }
  if (process.env["DOCGIT_BOOT_CHECK"] === "1") {
    void runBootCheck();
    return;
  }
  service = new DocumentService(node_path.join(electron.app.getPath("userData"), "docgit.db"), notifyRenderer);
  registerIpc(service);
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  electron.app.quit();
});
electron.app.on("will-quit", () => {
  service?.dispose();
});
