'use strict';
var rpm = require('integration-common/api-wrappers');
var rpmUtil = require('integration-common/util');
var util = require('util');

var KNOWN_FIELD_TYPES = [rpm.OBJECT_TYPE.CustomField];

var DATA_TYPES = exports.SUPPORTED_DATA_TYPES = (function () {
    var typesWithRows = [
        rpm.DATA_TYPE.FieldTable,
        rpm.DATA_TYPE.FieldTableDefinedRow,
    ];

    var typesWithOptions = [
        rpm.DATA_TYPE.DeprecatedTable,
        rpm.DATA_TYPE.List,
        rpm.DATA_TYPE.ListMultiSelect,
        rpm.DATA_TYPE.YesNoList,
        rpm.DATA_TYPE.LocationList,
    ];

    var supportedTypes = {};

    [
        rpm.DATA_TYPE.Text,
        rpm.DATA_TYPE.Http,   // This is a fixed link
        rpm.DATA_TYPE.Date,
        rpm.DATA_TYPE.YesNo,
        rpm.DATA_TYPE.List,
        rpm.DATA_TYPE.Money,
        rpm.DATA_TYPE.ListMultiSelect,
        rpm.DATA_TYPE.TextArea,
        rpm.DATA_TYPE.Link,
        rpm.DATA_TYPE.Number,
        rpm.DATA_TYPE.Money4,
        rpm.DATA_TYPE.Percent,
        rpm.DATA_TYPE.FixedNumber, // Fixed
        rpm.DATA_TYPE.SpecialPhone, // WTF?
        rpm.DATA_TYPE.LocationLatLong, // WTF?
        rpm.DATA_TYPE.Decimal,
        rpm.DATA_TYPE.LocationUTM,
        rpm.DATA_TYPE.LocationDLS,
        rpm.DATA_TYPE.LocationNTS,
        rpm.DATA_TYPE.WellUWI,
        rpm.DATA_TYPE.WellAPI,
        rpm.DATA_TYPE.DateTime,
        rpm.DATA_TYPE.MeasureLengthSmall,
        rpm.DATA_TYPE.MeasureLengthMedium,
        rpm.DATA_TYPE.MeasurePressure,
        rpm.DATA_TYPE.MeasureArea,
        rpm.DATA_TYPE.MeasureWeight,
        rpm.DATA_TYPE.Force,
        rpm.DATA_TYPE.MeasureDensity,
        rpm.DATA_TYPE.MeasureFlow,
        rpm.DATA_TYPE.MeasureTemperature,
        rpm.DATA_TYPE.YesNoList,
        rpm.DATA_TYPE.LocationList,
        
        
        
        // == TODO Enable when fixed in RPM ==        
        // rpm.DATA_TYPE.FieldTable,
        // rpm.DATA_TYPE.FieldTableDefinedRow,
        // ===================================
        
                
        
    ].forEach(function (typ) {
        var desc = supportedTypes[typ] = {};
        if (typesWithOptions.indexOf(typ) >= 0) {
            desc.hasOptions = true;
        }
        if (typesWithRows.indexOf(typ) >= 0) {
            desc.hasRows = true;
        }
        Object.freeze(desc);
    });
    Object.freeze(supportedTypes);
    return supportedTypes;
})();

function isFieldSupported(field) {
    return field.UserCanEdit && !field.IsRepeating && KNOWN_FIELD_TYPES.indexOf(field.FieldType) >= 0 && DATA_TYPES[field.SubType];
}

function FieldMappingInfo(srcFields, dstFields, efm) {

    efm = efm || {};

    this.uidMap = {};
    this.rowMap = {};
    this.optionMap = {};
    this.fieldMap = {};

    for (var srcFieldName in srcFields) {
        var dstFieldName = efm[srcFieldName] || srcFieldName;
        var dst = dstFields[dstFieldName];
        if (!dst) {
            continue;
        }
        try {
            this.merge(new FieldsMatcher(srcFields[srcFieldName], dst));
            this.fieldMap[srcFieldName] = dstFieldName;
        } catch (error) {
            console.warn(error);
        }
    }
    console.log('FieldMappingInfo', this);
}


FieldMappingInfo.prototype.processJsonValue = function (original) {
    if (typeof original !== 'string') {
        return original;
    }
    var value = tryJsonParse(original);
    if (typeof value !== 'object') {
        return original;
    }
    var changed;
    if (Array.isArray(value.Values)) {
        for (var key in value.Values) {
            var element = value.Values[key];
            var option = element.OptionID && this.optionMap[element.OptionID];
            if (option) {
                element.OptionID = option;
                changed = true;
            }
        }
    }
    return changed ? JSON.stringify(value) : original;
};


FieldMappingInfo.prototype.getDestinationFields = function (srcFields, currentDstFields) {
    var self = this;
    var result = [];


    var curDstFieldsByName = {};
    var curDstFieldsByUid = {};
    currentDstFields && currentDstFields.forEach(function (field) {
        curDstFieldsByName[field.Field] = field;
        curDstFieldsByUid[field.Uid] = field;
    });

    function getDestinationRow(field) {
        if (!field.Rows) {
            return;
        }
        var currentField = curDstFieldsByName[field.Field] || curDstFieldsByUid[field.Uid];
        var currentDefRow;
        var currentRows = {};

        if (currentField) {
            currentField.Rows.forEach(function (row) {
                if (row.IsLabelRow) {
                    return;
                }
                if (row.IsDefinition) {
                    currentDefRow = row;
                } else if (row.TemplateDefinedRowID) {
                    currentRows[row.TemplateDefinedRowID] = row;
                }
            });
        }

        var result = [];
        // var order = 0;
        field.Rows.forEach(function (row) {
            if (row.IsLabelRow) {
                return;
            }
            var v;
            if (row.IsDefinition) {
                if (currentDefRow) {
                    v = currentDefRow;
                } else {
                    v = {
                        RowID: 0,
                        TemplateDefinedRowID: 0,
                        IsDefinition: true,
                        // Order: 0,
                        Fields: []
                    };
                    row.Fields.forEach(function (field) {
                        v.Fields.push({
                            Values: [],
                            Uid: self.uidMap[field.Uid]
                        });
                    });
                }
                result.unshift(v);
                return;
            }
            var templateId = self.rowMap[row.TemplateDefinedRowID];
            var existingRow = currentRows[templateId];

            result.push({
                RowID: existingRow && existingRow.RowID || 0,
                TemplateDefinedRowID: templateId || 0,
                Order: existingRow && existingRow.Order || 0,
                Fields: row.Fields.map(self.getDestinationField.bind(self))
            });

        });
        return result;
    }


    srcFields.forEach(function (field) {
        var dst = {
            Field: self.fieldMap[field.Field],
            Uid: self.uidMap[field.Uid],
        };
        if (!dst.Uid && !dst.Field) {
            return;
        }
        if (field.Value !== 'undefined') {
            dst.Value = self.processJsonValue(field.Value);
        }
        if (field.Rows) {
            dst.Rows = getDestinationRow(field);
        }
        result.push(dst);
    });
    console.log('ssssssssssss',result);
    return result;
};

function tryJsonParse(value) {
    if (typeof value !== 'string') {
        return value;
    }
    try {
        value = JSON.parse(value);
    } catch (err) {
    }
    return value;
}

FieldMappingInfo.prototype.getDestinationValue = function (value) {
    var self = this;
    var id = self.optionMap[value.ID];
    return {
        ID: id ? '' + id : 0,
        Value: value.Value
    };
};

FieldMappingInfo.prototype.getDestinationField = function (field) {
    var self = this;
    return {
        Uid: self.uidMap[field.Uid],
        Values: field.Values.map(self.getDestinationValue.bind(self))
    };
};

FieldMappingInfo.prototype.merge = function (fm) {
    var self = this;
    ['uidMap', 'rowMap', 'optionMap'].forEach(function (property) {
        var reciever = self[property];
        var source = fm[property];
        for (var key in source) {
            reciever[key] = source[key];
        }
    });
};

FieldsMatcher.prototype.matchProcessFields = function (src, dst) {
    [src, dst].forEach(function (field) {
        if (!isFieldSupported(field)) {
            throwFieldNotSupportedError(field);
        }
    });
    var typ = src.SubType;
    if (dst.SubType != typ) {
        throwIncompatibleTypesError(src, dst);
    }
    typ = DATA_TYPES[typ];
    if (typ.hasRows) {
        this.matchRows(src, dst);
    }
    if (typ.hasOptions) {
        this.matchOptions(src, dst);
    }
    this.uidMap[src.Uid] = dst.Uid;
};

function FieldsMatcher(src, dst) {
    this.uidMap = {};
    this.rowMap = {};
    this.optionMap = {};
    this.matchProcessFields(src, dst);
}

function getTableRows(processField) {
    var result = { rowIds: {} };
    processField.Rows && processField.Rows.forEach(function (row) {
        if (row.IsLabelRow) {
            return;
        }
        if (!row.IsDefinition) {
            result.rowIds[row.Name] = row.ID;
        } else if (!result.definitionRow) {
            var fields = {};
            row.Fields.forEach(function (tableField) {
                if (!isFieldSupported(tableField)) {
                    throwFieldNotSupportedError(tableField);
                }
                fields[tableField.Name] = tableField;
            });
            result.fields = fields;
        }
    });
    if (!result.fields) {
        rpmUtil.throwError('Definition row is absent for field: ' + processField.Name, 'NoTableDefinitionRowError', { field: processField });
    }
    return result;
};


FieldsMatcher.prototype.matchRows = function (field1, field2) {

    var rows1 = getTableRows(field1);
    var rows2 = getTableRows(field2);
    var self = this;
    rpmUtil.matchObjects(rows1.fields, rows2.fields, self.matchProcessFields.bind(self));

    rpmUtil.matchObjects(rows1.rowIds, rows2.rowIds, function (id1, id2) {
        self.rowMap[id1] = id2;
    });

};

function getOptions(processField) {
    var options = {};
    processField.Options && processField.Options.forEach(function (option) {
        if (!option.IsLabel) {
            options[option.Text] = option.ID;
        }
    });
    for (var key in options) {
        return options;
    }
    rpmUtil.throwError('Options are not defined for field ' + processField.Name, 'NoOptionsError', { field: processField });
}

FieldsMatcher.prototype.matchOptions = function (field1, field2) {
    var opts1 = getOptions(field1);
    var opts2 = getOptions(field2);
    var self = this;
    rpmUtil.matchObjects(opts1, opts2, function (id1, id2) {
        self.optionMap[id1] = id2;
    });
};

function throwFieldNotSupportedError(field) {
    rpmUtil.throwError('Field not supported: ' + field.Name, 'FieldNotSupportedError', { field: field });
}

function throwIncompatibleTypesError(field1, field2) {
    rpmUtil.throwError(util.format('Incompatible field types: ["%s.%d", "%s.%d"]', field1.Name, field1.SubType, field2.Name, field1.SubType),
        'IncompatibleTypesError', { field1: field1, field2: field2 });
}



exports.FieldMappingInfo = FieldMappingInfo;

