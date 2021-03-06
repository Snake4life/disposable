var config = require("../config/" + (process.env.NODE_ENV || "development") + ".json"),
    MailParser = require("mailparser").MailParser,
    indentText = require("mailpurify").indentText,
    zlib = require('zlib'),
    Stream = require("stream").Stream,
    ObjectID = require('mongodb').ObjectID,
    mongodb = require("mongodb"),
    mongoserver = new mongodb.Server(config.mongo.host, config.mongo.port || 27017, {auto_reconnect: true}),
    db_connector = new mongodb.Db(config.mongo.name, mongoserver, {safe: false}),
    dbObj,
    moment = require("moment");

module.exports.initDB = initDB;
module.exports.loadMailbox = loadMailbox;
module.exports.loadMessage = loadMessage;
module.exports.loadRawMessage = loadRawMessage;
module.exports.loadAttachments = loadAttachments;
module.exports.storeRawMessage = storeRawMessage;
module.exports.deleteMessage = deleteMessage;

/**
 * Open MongoDB connection, ensure indexes and store database connection pointer to module level variable
 * This should be the first thing to run, everything else should be run after the callback fires.
 *
 * @param {Function} callback Callback function to run after connection to database has been established or failed
 */
function initDB(callback){
    db_connector.open(function(err, db){
        if(err){
            return callback(err);
        }
        dbObj = db;

        db.ensureIndex(config.mongo.collection, {received: 1}, { expireAfterSeconds: config.mongo.ttl }, function(err){
            if(err){
                return callback(err);
            }
            db.ensureIndex(config.mongo.collection, {received: -1}, function(err){
                if(err){
                    return callback(err);
                }
                db.ensureIndex(config.mongo.collection, {mailbox: 1}, function(err){
                    if(err){
                        return callback(err);
                    }
                    return callback(null, db);
                });
            });
        });
    });
}

/**
 * Parses a raw RFC2822 message and stores it to database. Callback function gets the db entity id
 *
 * @param {String} mailbox The mailbox (e-mail address) the message should be stored into
 * @param {String} from Sender address
 * @param {Buffer} rawMessage RFC2822 or mboxrd format e-mail
 * @param {Function} callback Callback function to run after the message is stored
 */
function storeRawMessage(mailbox, from, rawMessage, callback){
    var mailparser = new MailParser({showAttachmentLinks: true});
    mailparser.on("end", function(message){
        indentText(message.text || "", function(err, textHTML){
            message.html = message.html || textHTML;
            if(message.attachments){
                for(var i=0, len = message.attachments.length; i<len; i++){
                    message.attachments[i].content = message.attachments[i].content.toString("base64");
                }
            }

            rawMessage = Buffer.concat([
                new Buffer("Delivered-To: "+((mailbox || "").toLowerCase().trim())+"\r\n", "utf-8"),
                rawMessage]);

            storeMessage(mailbox, from, rawMessage, message, callback);
        });
    });
    mailparser.end(rawMessage);
}

/**
 * Stores e-mail message object to database. Callback function gets the db entity id.
 * Raw message source will be gzipped and stored as a property of the message (needed for pop3 retrieval)
 *
 * @param {String} mailbox The mailbox (e-mail address) the message should be stored into
 * @param {String} from Sender address
 * @param {Buffer} rawMessage RFC2822 or mboxrd format e-mail
 * @param {Object} message parsed e-mail message object
 * @param {Function} callback Callback function to run after the message is stored
 */
function storeMessage(mailbox, from, rawMessage, message, callback){
     var data = {
        received: new Date(),
        from: from,
        read: false,
        mailbox: (mailbox || "").toLowerCase().trim(),
        message: message
    };

    zlib.gzip(rawMessage, function(err, buffer) {
        if (!err && buffer) {
            data.raw = buffer.toString("base64");
            data.rawsize = rawMessage.length;
        }else{
            data.raw = "";
            data.rawsize = 0;
        }

        dbObj.collection(config.mongo.collection, function(err, collection){
            if(err){
                return callback(err);
            }
            collection.insert(data, {safe: true}, function(err, records){
                if(err){
                    return callback(err);
                }
                if(records && records.length){
                    return callback(null, records[0]._id);
                }
                return callback(null, false);
            });
        });
    });
}

/**
 * Loads an array of messages from a mailbox.
 *
 * @param {String} mailbox The mailbox (e-mail address) the messages should be loaded from
 * @param {Boolean} includeHTML If set to true include full HTML of the message in the response objects
 * @param {Function} callback Callback function to run with the loaded messages
 */
function loadMailbox(mailbox, includeHTML, callback){
    if(!callback && typeof includeHTML == "function"){
        callback = includeHTML;
        includeHTML = undefined;
    }
    includeHTML = !!includeHTML;

    dbObj.collection(config.mongo.collection, function(err, collection){
        if(err){
            return callback(err);
        }
        var list = [],
            includeFields = {
                from: true,
                mailbox: true,
                "message.subject": true,
                read:true,
                received: true,
                rawsize: true,
                "message.from": true,
                "message.replyTo": true,
                "message.to": true,
                "message.cc": true};
        if(includeHTML){
            includeFields["message.attachments"] = true;
            includeFields["message.html"] = true;
        }

        collection.find({mailbox: mailbox},
          includeFields,
          {sort: [["received", "desc"]], limit: config.mailbox.maxMessages}).toArray(function(err, docs){
            if(err){
                return callback(err);
            }
            docs.forEach(function(elm){
                var returnElm = {
                    id: elm._id,
                    mailbox: elm.mailbox,
                    date:{
                        received: elm.received,
                        relative: moment(elm.received).fromNow(),
                        formatted: moment(elm.received).format(config.mailbox.dateFormat)
                    },
                    read: !!elm.read,
                    envelope: {
                        from: elm.from,
                        to: elm.mailbox
                    },
                    size: elm.rawsize
                };

                if(elm.message.from && elm.message.from.length){
                    returnElm.from = elm.message.from;
                }

                if(elm.message.replyTo && elm.message.replyTo.length){
                    returnElm.replyTo = elm.message.replyTo;
                }

                if(elm.message.to && elm.message.to.length){
                    returnElm.to = elm.message.to;
                }

                if(elm.message.cc && elm.message.cc.length){
                    returnElm.cc = elm.message.cc;
                }

                if(elm.message.subject){
                    returnElm.subject = elm.message.subject;
                }

                if(includeHTML){
                    if(elm.message.attachments){
                        returnElm.attachments = elm.message.attachments.map(function(attachment, i){
                            attachment.i = i;
                            return attachment;
                        });
                    }

                    returnElm.html = (elm.message.html || "").
                        replace(/(\s(?:src|href)\s*=\s*['"])(?:cid:)([^'"\s]+)/ig, function(o, prefix, cid){
                            if(elm.message.attachments){
                                for(var i=0, len = elm.message.attachments.length; i<len; i++){
                                    if(elm.message.attachments[i].contentId == cid){
                                        return prefix + "http://" + config.hostname + "/attachment/"+returnElm.id+"/"+i+"/" + elm.message.attachments[i].generatedFileName.replace(/</g,"&lt;").replace(/>/g,"&gt;");
                                    }
                                }
                            }
                            return prefix+"cid:"+cid;
                        }).
                        replace(/\r?\n|\r/g, "\u0000").
                        replace(/<script\b[^>]*>.*<\/script\b[^>]*>/ig, " ").
                        replace(/\bon[a-z]{3,}\s*=/gi, "").
                        replace(/\u0000/g, "\n").trim();
                }

                list.push(returnElm);
            });
            return callback(null, list);
        });
    });
}

/**
 * Retrieves a single message object from a mailbox.
 *
 * @param {String} messageId The message id of the message that should be loaded
 * @param {Function} callback Callback function to run with the loaded message object
 */
function loadMessage(messageId, callback){
    dbObj.collection(config.mongo.collection, function(err, collection){
        if(err){
            return callback(err);
        }
        collection.findOne({_id: new ObjectID(messageId)},
          {raw: false},
          {}, function(err, elm){
            if(err){
                return callback(err);
            }
            if(!elm){
                return callback(err, false);
            }

            var returnElm = {
                id: messageId,
                mailbox: elm.mailbox,
                date:{
                    received: elm.received,
                    relative: moment(elm.received).fromNow(),
                    formatted: moment(elm.received).format(config.mailbox.dateFormat)
                },
                read: !!elm.read,
                envelope: {
                    from: elm.from,
                    to: elm.mailbox
                },
                size: elm.rawsize,

                // is the receiver in the to: field of the message
                direct: elm.message.to && elm.message.to.map(function(to){return to.address;}).reduce(function(prev, current){
                        return prev || current.toLowerCase().trim() == elm.mailbox.toLowerCase().trim();
                    }, false)
            };

            if(elm.message.from && elm.message.from.length){
                returnElm.from = elm.message.from;
            }

            if(elm.message.replyTo && elm.message.replyTo.length){
                returnElm.replyTo = elm.message.replyTo;
            }

            if(elm.message.to && elm.message.to.length){
                returnElm.to = elm.message.to;
            }

            if(elm.message.cc && elm.message.cc.length){
                returnElm.cc = elm.message.cc;
            }

            if(elm.message.replyTO && elm.message.to.length){
                returnElm.to = elm.message.to;
            }

            if(elm.message.subject){
                returnElm.subject = elm.message.subject;
            }

            if(!elm.read){
                collection.update({_id: new ObjectID(messageId)}, {$set: {read:true}});
            }

            if(elm.message.attachments){
                returnElm.attachments = elm.message.attachments.map(function(attachment, i){
                    attachment.i = i;
                    return attachment;
                });
            }

            if(elm.message.text){
                returnElm.text = elm.message.text;
            }

            returnElm.html = (elm.message.html || "").
                replace(/(\s(?:src|href)\s*=\s*['"])(?:cid:)([^'"\s]+)/ig, function(o, prefix, cid){
                    if(elm.message.attachments){
                        for(var i=0, len = elm.message.attachments.length; i<len; i++){
                            if(elm.message.attachments[i].contentId == cid){
                                return prefix + "http://" + config.hostname + "/attachment/"+returnElm.id+"/"+i+"/" + elm.message.attachments[i].generatedFileName.replace(/</g,"&lt;").replace(/>/g,"&gt;");
                            }
                        }
                    }
                    return prefix+"cid:"+cid;
                }).
                replace(/\r?\n|\r/g, "\u0000").
                replace(/<script\b[^>]*>.*<\/script\b[^>]*>/ig, " ").
                replace(/\bon[a-z]{3,}\s*=/gi, "").
                replace(/\u0000/g, "\n").trim();

            return callback(null, returnElm);
        });
    });
}

/**
 * Retrieves a single message as the raw source buffer from a mailbox.
 *
 * @param {String} messageId The message id of the message that should be loaded
 * @param {Function} callback Callback function to run with the loaded message
 */
function loadRawMessage(messageId, callback){
    dbObj.collection(config.mongo.collection, function(err, collection){
        if(err){
            return callback(err);
        }
        collection.findOne({_id: new ObjectID(messageId)},
          {raw: true},
          {}, function(err, elm){
            if(err){
                return callback(err);
            }
            if(!elm){
                return callback(null, false);
            }

            zlib.gunzip(new Buffer(elm.raw || "", "base64"), function(err, buffer) {
                if(err){
                    return callback(err);
                }
                return callback(null, buffer);
            });
        });
    });
}

/**
 * Retrieves attachments array for a message.
 *
 * @param {String} messageId The message id of the message for the attachments
 * @param {Function} callback Callback function to run with the attachments array
 */
function loadAttachments(messageId, callback){
    dbObj.collection(config.mongo.collection, function(err, collection){
        if(err){
            return callback(err);
        }
        collection.findOne({_id: new ObjectID(messageId)},
          {"message.attachments": true},
          {}, function(err, elm){
            if(err){
                return callback(err);
            }
            if(!elm || !elm.message || !elm.message.attachments){
                return callback(null, false);
            }

            for(var i=0, len = elm.message.attachments.length; i<len; i++){
                elm.message.attachments[i].content = new Buffer(elm.message.attachments[i].content, "base64");
            }

            return callback(null, elm.message.attachments);
        });
    });
}

/**
 * Removes a message from mailbox/database
 *
 * @param {String} messageId The message id of the message that should be removed
 * @param {Function} callback Callback function to run
 */
function deleteMessage(messageId, callback){
    dbObj.collection(config.mongo.collection, function(err, collection){
        if(err){
            return callback(err);
        }
        collection.remove({_id: new ObjectID(messageId)}, function(err){
            if(err){
                return callback(err);
            }
            return callback(null, true);
        });
    });
}