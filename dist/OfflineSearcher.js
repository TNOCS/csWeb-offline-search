var path = require('path');
var fs = require('fs');
var osr = require('./OfflineSearchResult');
/**
* Offline Search reads the solution file, and creates an OfflineSearchResult for each project it contains.
*/
var OfflineSearcher = (function () {
    function OfflineSearcher(project, options) {
        var _this = this;
        this.project = project;
        this.options = options;
        this.propertyNames = [];
        this.filesToProcess = 0;
        this.result = new osr.OfflineSearchResult(project, options);
        this.layers = this.result.layers;
        this.stopWords = this.result.options.stopWords;
        this.keywordIndex = this.result.keywordIndex;
        this.result.options.propertyNames.forEach(function (pt) {
            _this.propertyNames.push(pt);
        });
    }
    Object.defineProperty(OfflineSearcher.prototype, "savedFilename", {
        get: function () {
            return 'public/' + this.project.url.replace('project.json', 'offline_search_result.json');
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(OfflineSearcher.prototype, "projectFilename", {
        get: function () {
            return 'public/' + this.project.url;
        },
        enumerable: true,
        configurable: true
    });
    /**
     * Return the (local) layer file name.
     */
    OfflineSearcher.prototype.layerFilename = function (baseUrl) {
        return 'public/' + baseUrl;
    };
    /**
     * Process the project by extracting the groups and processing each layer.
     */
    OfflineSearcher.prototype.processProject = function () {
        var _this = this;
        fs.readFile(this.projectFilename, 'utf8', function (err, data) {
            if (err) {
                console.log('Error: ' + err);
                return;
            }
            var project = JSON.parse(data);
            if (!project.groups)
                return;
            project.groups.forEach(function (group) {
                if (!group.layers)
                    return;
                group.layers.forEach(function (layer) {
                    var layerType = layer.type.toLowerCase();
                    if (!(layerType === 'geojson'))
                        return;
                    _this.processLayer(layer, group.title || group.languages['nl'].title);
                });
            });
            _this.saveResult();
        });
    };
    /**
     * Process a single layer by calling processProperties on each feature.
     * @layer {ILayer}
     */
    OfflineSearcher.prototype.processLayer = function (layer, groupTitle) {
        var _this = this;
        this.filesToProcess++;
        if (layer.title == null)
            layer.title = layer.id;
        var layerIndex = this.layers.length;
        var resultLayer = new osr.Layer(groupTitle, layerIndex, layer.id, layer.title, layer.url, layer.type);
        this.layers.push(resultLayer);
        var featureTypeLookup = {};
        if (layer.typeUrl != null) {
            //console.log('Load resource type file ' + layer.typeUrl);
            var typeFileLocation = path.resolve('public', layer.typeUrl);
            var layerTypes = JSON.parse(fs.readFileSync(typeFileLocation).toString());
            var featureTypeIds = Object.getOwnPropertyNames(layerTypes.featureTypes);
            featureTypeIds.forEach(function (featureTypeId) {
                featureTypeLookup[featureTypeId] = layerTypes.featureTypes[featureTypeId];
            });
        }
        console.log(layerIndex + '. Processing ' + layer.title + ' (' + groupTitle + ')');
        fs.readFile(this.layerFilename(layer.url), 'utf8', function (err, data) {
            if (err) {
                _this.filesToProcess--;
                console.log(err);
                _this.saveResult();
                return;
            }
            var geojson = JSON.parse(data);
            if (geojson.featureTypes != null) {
                var featureTypeIds = Object.getOwnPropertyNames(geojson.featureTypes);
                featureTypeIds.forEach(function (featureTypeId) {
                    featureTypeLookup[featureTypeId] = geojson.featureTypes[featureTypeId];
                });
            }
            var featureIndex = 0;
            if (!geojson.features)
                return;
            geojson.features.forEach(function (feature) {
                var featureTypeId = feature.properties['FeatureTypeId'] || layer.defaultFeatureType;
                if (featureTypeId == null) {
                    console.log("Unknown feature type " + featureTypeId + " for feature in layer " + layer.url + " (" + layer.defaultFeatureType + ")");
                    return;
                }
                var featureType = featureTypeLookup[featureTypeId];
                if (featureType == null) {
                    console.log("Cannot find featureType " + featureTypeId + " for feature in layer " + layer.url);
                    return;
                }
                var nameLabel = featureType.style.nameLabel;
                var effectiveProperties = _this.propertyNames.slice(0); // copy provided property names
                if (nameLabel != null) {
                    if (effectiveProperties.indexOf(nameLabel) === -1) {
                        effectiveProperties.push(nameLabel); // add name label if it wasn't included in te provided property names
                    }
                }
                else {
                    nameLabel = 'Name';
                    if (!feature.properties[nameLabel]) {
                        console.log('Cannot resolve nameLabel for feature in layer ' + layer.url);
                    }
                }
                resultLayer.featureNames.push(_this.getShortenedName(feature, nameLabel));
                if (feature.hasOwnProperty('properties'))
                    _this.processProperties(feature.properties, effectiveProperties, layerIndex, featureIndex++);
            });
            console.log(layerIndex + '. Processed ' + layer.title);
            _this.filesToProcess--;
            _this.saveResult();
        });
    };
    /**
     * Get the shortened name of a feature.
     */
    OfflineSearcher.prototype.getShortenedName = function (feature, nameLabel) {
        if (nameLabel == null) {
            nameLabel = 'Name';
        }
        var name = feature.properties.hasOwnProperty(nameLabel)
            ? feature.properties[nameLabel]
            : feature.properties.hasOwnProperty('name')
                ? feature.properties['name']
                : 'Unknown';
        if (name.length > 25)
            name = name.substring(0, 22) + '...';
        return name;
    };
    /**
     * Process each property that is included, and save the resulting Entry for each word
     * that is not a stop word.
     * @props {geo.IStringToAny}
     * @layerIndex {number}
     * @featureIndex {number}
     */
    OfflineSearcher.prototype.processProperties = function (props, propertiesToIndex, layerIndex, featureIndex) {
        var _this = this;
        for (var i = 0; i < propertiesToIndex.length; i++) {
            var key = propertiesToIndex[i];
            if (!props.hasOwnProperty(key))
                continue;
            var value = props[key];
            if (typeof value === 'string') {
                var words = value.split(' ');
                if (words.length <= 0)
                    continue;
                words.forEach(function (word) {
                    // if (layerIndex === 10 && word.toLowerCase() === 'parnassia')
                    //     debugger;
                    _this.addEntry(word, layerIndex, featureIndex);
                });
            }
            else {
                // Value is a number
                this.addEntry('' + value, layerIndex, featureIndex);
            }
        }
        //   for (var key in props) {
        //       var propertyIndex = this.propertyNames.indexOf(key);
        //       if (propertyIndex >= 0) {
        //           var words = props[key].split(' ');
        //           if (words.length <= 0) continue;
        //           words.forEach((word) => {
        //               this.addEntry(word, layerIndex, featureIndex, propertyIndex)
        //           });
        //       }
        //   }
    };
    /**
     * Add a new or enhance an existing entry.
     * @key {string}
     * @layerIndex {number}
     * @featureIndex {number}
     * @propertyIndex {number}
     */
    OfflineSearcher.prototype.addEntry = function (key, layerIndex, featureIndex) {
        key = key.toLowerCase();
        if (this.stopWords.indexOf(key) >= 0)
            return;
        if (!this.keywordIndex.hasOwnProperty(key)) {
            this.keywordIndex[key] = [];
        }
        else {
            // Check for duplicate keys
            var entries = this.keywordIndex[key];
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (entry.layerIndex === layerIndex && entry.featureIndex === featureIndex)
                    return;
            }
        }
        this.keywordIndex[key].push(new osr.Entry(layerIndex, featureIndex));
    };
    /**
     * Add a new or enhance an existing entry.
     * @key {string}
     * @entry {number[]}
     */
    OfflineSearcher.prototype.addFullEntry = function (key, entry) {
        if (!this.keywordIndex.hasOwnProperty(key)) {
            this.keywordIndex[key] = [];
        }
        this.keywordIndex[key].push(new osr.Entry(entry));
    };
    OfflineSearcher.prototype.saveResult = function () {
        if (this.filesToProcess > 0)
            return;
        var file = this.savedFilename;
        fs.writeFile(file, JSON.stringify(this.result, null, 0), function (err) {
            if (err) {
                console.log(err);
            }
            else {
                console.log('JSON saved to ' + file);
            }
        });
    };
    OfflineSearcher.prototype.loadResult = function () {
        var _this = this;
        var file = this.savedFilename;
        fs.readFile(file, 'utf8', function (err, data) {
            if (err) {
                console.log('Error: ' + err);
                return;
            }
            var osr = JSON.parse(data);
            _this.layers = osr.layers;
            _this.options = osr.options;
            _this.propertyNames = [];
            _this.project = osr.project;
            _this.stopWords = osr.options.stopWords;
            osr.options.propertyNames.forEach(function (pt) {
                _this.propertyNames.push(pt.toLowerCase());
            });
            _this.keywordIndex = {};
            for (var key in osr.keywordIndex) {
                osr.keywordIndex[key].forEach(function (entry) {
                    _this.addFullEntry(key, entry);
                });
            }
        });
    };
    return OfflineSearcher;
})();
exports.OfflineSearcher = OfflineSearcher;
