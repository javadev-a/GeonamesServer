var S = require('string');
var _ = require('underscore');
var request = require('request');
var Promise = require('bluebird');

var geoloc = require('./../lib/geoloc');
var common = require('./../lib/common');
var controller = require('./../lib/controller/city');

module.exports = function(app) {
    app.get('/city', function(req, res) {
        var countryNamesCollection = app.get('mongodb').collection('countrynames');

        var cityName = S(req.query.name || '').trim().toString();
        var countryName = S(req.query.country || '').trim().toString();

        // find city
        var codes = [];
        countryNamesCollection.find({}, function(err, countries) {
            if ('' !== countryName) {
                _.each(countries, function(country) {
                    if (S(country.name.toLowerCase()).contains(countryName)) {
                        codes.push(country.code.toLowerCase());
                    }
                });

                if (codes.length === 0) {
                    common.sendEmptyResponse(res);
                    return;
                }
            }

            var point;

            if ('closeness' === app.get('req.sort')) {
                // Get client ip
                var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;

                if ('127.0.0.1' === ip) {
                    console.error('Error : Detected remote client address is 127.0.0.1, server is probably misconfigured.');
                    ip = null;
                }

                if ('undefined' !== typeof(req.query['client-ip'])) {
                    ip = req.query['client-ip'];
                }

                if (!common.isIpV4(ip)) {
                    return common.sendBadRequestResponse(res, "The provided IP " + ip + " is not valid");
                }

                // if ip or city could not be found fallback to sort by population
                if (ip) {
                    try {
                        var point = geoloc.getPointfromIp(ip);

                        if (null === point) {
                            app.set('req.sort', 'population');
                            res.header('X-Geonames-SortBy', app.get('req.sort'));
                        }
                    } catch (Exception) {
                        res.send(500, 'An error occured while geolocalizing IP adress');
                        return;
                    }
                } else {
                    app.set('req.sort', 'population');
                    res.header('X-Geonames-SortBy', app.get('req.sort'));
                }
            }

            var requestBody = controller.esQuery.findCitiesByName(
                    cityName,
                    codes,
                    point,
                    app.get('req.sort'),
                    app.get('req.limit')
            );

            request({
                uri: app.get('es.connection.string')('cities'),
                body: requestBody
            }, function(error, response, hits) {
                if (!error && response.statusCode === 200) {
                    var result = common.formatHits(hits);

                    var datas = result.data;
                    var adminCodes = result.admincodes;

                    if (datas.length === 0) {
                        common.sendEmptyResponse(res);
                        return;
                    }

                    var datas = controller.sortDatasFromCountries(datas, countries);

                    var promises = [];
                    promises.push(new Promise(function(resolve, reject) {
                        app.get('mongodb').collection('admincodes').find({code: {$in: adminCodes}}, function(err, result) {
                            resolve(result);
                        });
                    }));

                    //Find the admin 2 code of each result
                    _.each(datas, function(o) {
                        promises.push(new Promise(function(resolve, reject) {
                            var admin2code = o.countryCode + '.' + o.admin1Code + '.' + o.admin2Code;

                            app.get('mongodb').collection('admin2codes').findOne({code: admin2code}, function(err, result) {
                                resolve(result);
                            });
                        }));
                    });

                    Promise.all(promises).then(function(results) {
                        res.header('X-Geonames-Total', datas.length.toString());

                        res.jsonp(controller.jsonFromQueryLookup(results, datas));
                    });
                } else {
                    console.log('elastic search error, got error ', error, ' status code ', res.statusCode, ' and response ', response);
                    return common.sendErrorResponse(res);
                }
            });
        });
    });

    app.get('/city/:id', function(req, res) {
        var countryNamesCollection = app.get('mongodb').collection('countrynames');

        countryNamesCollection.find({}, function(err, countries) {
            var requestBody = controller.esQuery.findCityById(req.params.id);

            request({
                uri: app.get('es.connection.string')('cities'),
                body: requestBody
            },
            function(error, response, hits) {
                if (!error && response.statusCode === 200) {
                    var result = common.formatHits(hits);

                    var datas = result.data;
                    var adminCodes = result.admincodes;

                    if (datas.length === 0) {
                        common.sendNotFoundResponse(res);
                        return;
                    }

                    datas = controller.sortDatasFromCountries(datas, countries);
                    datas = datas.pop();

                    var admin1codeData = new Promise(function(resolve, reject) {
                        app.get('mongodb').collection('admincodes').find({code: {$in: adminCodes}}, function(err, result) {
                            resolve(result);
                        });
                    });

                    var admin2codeData = new Promise(function(resolve, reject) {
                        var admin2code = datas.countryCode + '.' + datas.admin1Code + '.' + datas.admin2Code;

                        app.get('mongodb').collection('admin2codes').findOne({code: admin2code}, function(err, result) {
                            resolve(result);
                        });
                    });

                    Promise.all([admin1codeData, admin2codeData]).then(function(result) {
                        res.jsonp(controller.jsonFromGeonameLookup(result[0], result[1], datas));
                    });

                } else {
                    return common.sendErrorResponse(res);
                }
            });
        });
    });

    app.get('/ip', function(req, res) {
        var ip = req.query.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        if (!common.isIpV4(ip)) {
            return common.sendBadRequestResponse(res, "Could not determine your remote IP or the provided one is not valid");
        }

        var city = geoloc.getCityFromIp(ip);

        if (!city || !city.city) {
            return common.sendNotFoundResponse(res);
        }

        var countryNamesCollection = app.get('mongodb').collection('countrynames');
        countryNamesCollection.find({}, function(err, countries) {
            var requestBody = controller.esQuery.findCitiesByName(
                city.city,
                [city.country.toLowerCase()],
                {longitude:city.ll[1],latitude:city.ll[0]},
                'closeness',
                1
            );

            request({
                uri: app.get('es.connection.string')('cities'),
                body: requestBody
            }, function(error, response, hits) {
                if (!error && response.statusCode === 200) {
                    var result = common.formatHits(hits);

                    var datas = result.data;
                    var adminCodes = result.admincodes;

                    if (datas.length === 0) {
                        return common.sendNotFoundResponse(res);
                    }

                    var datas = controller.sortDatasFromCountries(datas, countries);
                    datas = datas.pop();

                    var admin1codeData = new Promise(function(resolve, reject) {
                        app.get('mongodb').collection('admincodes').find({code: {$in: adminCodes}}, function(err, result) {
                            resolve(result);
                        });
                    });

                    var admin2codeData = new Promise(function(resolve, reject) {
                        var admin2code = datas.countryCode + '.' + datas.admin1Code + '.' + datas.admin2Code;

                        app.get('mongodb').collection('admin2codes').findOne({code: admin2code}, function(err, result) {
                            resolve(result);
                        });
                    });

                    Promise.all([admin1codeData, admin2codeData]).then(function(result) {
                        res.jsonp(controller.jsonFromIpLookup(result[0], result[1], datas, ip));
                    });
                } else {
                    console.log('elastic search error, got error ', error, ' status code ', res.statusCode, ' and response ', response);
                    return common.sendErrorResponse(res);
                }
            });
        });
    });
};
