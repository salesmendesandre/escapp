const Sequelize = require("sequelize");
const sequelize = require("../models");
const {models} = sequelize;
const cloudinary = require("cloudinary");
const query = require("../queries");
const attHelper = require("../helpers/attachments");
const {nextStep, prevStep} = require("../helpers/progress");
const {saveInterface} = require("../helpers/utils");

// Autoload the escape room with id equals to :escapeRoomId
exports.load = async (req, res, next, escapeRoomId) => {
    try {
        const escapeRoom = await models.escapeRoom.findByPk(escapeRoomId, query.escapeRoom.load);

        if (escapeRoom) {
            req.escapeRoom = escapeRoom;
            next();
        } else {
            res.status(404);
            next(new Error(req.app.locals.i18n.api.notFound));
        }
    } catch (error) {
        res.status(500);
        next(error);
    }
};

// GET /escapeRooms
exports.index = async (req, res, next) => {
    const user = req.user || req.session.user;
    let escapeRooms = [];

    try {
        if (user && !user.isStudent) {
            escapeRooms = await models.escapeRoom.findAll({
                "attributes": ["id", "title", "invitation"],
                "include": [
                    models.attachment,
                    {
                        "model": models.user,
                        "as": "author",
                        "where": {"id": user.id}
                    }
                ]
            });
        } else {
            const erAll = await models.escapeRoom.findAll(query.escapeRoom.all());
            const erFiltered = await models.escapeRoom.findAll(query.escapeRoom.all(user.id));
            const ids = erFiltered.map((e) => e.id);

            escapeRooms = erAll.map((er) => {
                const {id, title, invitation, attachment, nmax} = er;
                const isSignedUp = ids.indexOf(er.id) !== -1;
                const disabled = !isSignedUp && !er.turnos.some((e) => e.status !== "finished" && e.students.length < nmax);

                return { id, title, invitation, attachment, disabled, isSignedUp };
            });
        }

        res.render("escapeRooms/index.ejs", {escapeRooms, cloudinary, user});
    } catch (error) {
        next(error);
    }
};

// GET /escapeRooms/:escapeRoomId
exports.show = (req, res) => {
    const {escapeRoom, participant} = req;
    const hostName = process.env.APP_NAME ? `https://${process.env.APP_NAME}` : "http://localhost:3000";

    if (participant) {
        res.render("escapeRooms/showStudent", {escapeRoom, cloudinary, participant});
    } else {
        res.render("escapeRooms/show", {escapeRoom, cloudinary, hostName, "email": req.session.user.username});
    }
};

// GET /escapeRooms/new
exports.new = (_req, res) => {
    const escapeRoom = {"title": "", "teacher": "", "subject": "", "duration": "", "description": "", "nmax": "", "teamSize": ""};

    res.render("escapeRooms/new", {escapeRoom, "progress": "edit"});
};

// POST /escapeRooms/create
exports.create = (req, res) => {
    const {title, subject, duration, forbiddenLateSubmissions, description, nmax, teamSize} = req.body,

        authorId = req.session.user && req.session.user.id || 0,

        escapeRoom = models.escapeRoom.build({title, subject, duration, forbiddenLateSubmissions, description, "nmax": nmax || 0, "teamSize": teamSize || 0, authorId}); // Saves only the fields question and answer into the DDBB

    escapeRoom.save({"fields": ["title", "teacher", "subject", "duration", "description", "forbiddenLateSubmissions", "nmax", "teamSize", "authorId", "invitation"]}).
        then((er) => {
            req.flash("success", req.app.locals.i18n.common.flash.successCreatingER);
            if (!req.file) {
                res.redirect(`/escapeRooms/${escapeRoom.id}/turnos`);

                return;
            }
            // Save the attachment into  Cloudinary

            return attHelper.checksCloudinaryEnv().
                then(() => attHelper.uploadResource(req.file.path, attHelper.cloudinary_upload_options)).
                then((uploadResult) => models.attachment.create({
                    "public_id": uploadResult.public_id,
                    "url": uploadResult.url,
                    "filename": req.file.originalname,
                    "mime": req.file.mimetype,
                    "escapeRoomId": er.id
                }).
                    catch((error) => { // Ignoring validation errors
                        console.error(error);
                        req.flash("error", `${req.app.locals.i18n.common.flash.errorImage}: ${error.message}`);
                        attHelper.deleteResource(uploadResult.public_id, models.attachment);
                    })).
                catch((error) => {
                    console.error(error);

                    req.flash("error", `${req.app.locals.i18n.common.flash.errorFile}: ${error.message}`);
                }).
                then(() => {
                    res.redirect(`/escapeRooms/${er.id}/${nextStep("edit")}`);
                });
        }).
        catch(Sequelize.ValidationError, (error) => {
            error.errors.forEach(({message}) => req.flash("error", message));
            res.render("escapeRooms/new", {escapeRoom, "progress": "edit"});
        }).
        catch((error) => {
            req.flash("error", `${req.app.locals.i18n.common.flash.errorCreatingER}: ${error.message}`);
            res.render("escapeRooms/new", {escapeRoom, "progress": "edit"});
        });
};

// GET /escapeRooms/:escapeRoomId/edit
exports.edit = (req, res) => {
    res.render("escapeRooms/edit", {"escapeRoom": req.escapeRoom, "progress": "edit"});
};

// PUT /escapeRooms/:escapeRoomId
exports.update = (req, res, next) => {
    const {escapeRoom, body} = req;

    escapeRoom.title = body.title;
    escapeRoom.subject = body.subject;
    escapeRoom.duration = body.duration;
    escapeRoom.forbiddenLateSubmissions = body.forbiddenLateSubmissions === "on";
    escapeRoom.description = body.description;
    escapeRoom.nmax = body.nmax || 0;
    escapeRoom.teamSize = body.teamSize || 0;
    const progressBar = body.progress;

    escapeRoom.save({"fields": ["title", "subject", "duration", "forbiddenLateSubmissions", "description", "nmax", "teamSize"]}).
        then((er) => {
            if (body.keepAttachment === "0") {
                // There is no attachment: Delete old attachment.
                if (!req.file) {
                    if (er.attachment) {
                        attHelper.deleteResource(er.attachment.public_id, models.attachment);
                        er.attachment.destroy();
                    }

                    return;
                }

                // Save the new attachment into Cloudinary:
                return attHelper.checksCloudinaryEnv().
                    then(() => attHelper.uploadResource(req.file.path, attHelper.cloudinary_upload_options)).
                    then((uploadResult) => {
                        // Remenber the public_id of the old image.
                        const old_public_id = er.attachment ? er.attachment.public_id : null;
                        // Update the attachment into the data base.

                        return er.getAttachment().
                            then((att) => {
                                let attachment = att;

                                if (!attachment) {
                                    attachment = models.attachment.build({"escapeRoomId": er.id});
                                }
                                attachment.public_id = uploadResult.public_id;
                                attachment.url = uploadResult.url;
                                attachment.filename = req.file.originalname;
                                attachment.mime = req.file.mimetype;

                                return attachment.save();
                            }).
                            then(() => {
                                if (old_public_id) {
                                    attHelper.deleteResource(old_public_id, models.attachment);
                                }
                            }).
                            catch((error) => { // Ignoring image validation errors
                                req.flash("error", `${req.app.locals.i18n.common.flash.errorFile}: ${error.message}`);
                                attHelper.deleteResource(uploadResult.public_id, models.attachment);
                            }).
                            then(() => {
                                res.redirect(`/escapeRooms/${req.escapeRoom.id}/${progressBar || nextStep("edit")}`);
                            });
                    }).
                    catch((error) => {
                        req.flash("error", `${req.app.locals.i18n.common.flash.errorFile}: ${error.message}`);
                    });
            }
        }).
        then(() => {
            res.redirect(`/escapeRooms/${req.escapeRoom.id}/${progressBar || nextStep("edit")}`);
        }).
        catch(Sequelize.ValidationError, (error) => {
            error.errors.forEach(({message}) => req.flash("error", message));
            res.render("escapeRooms/edit", {escapeRoom, "progress": "edit"});
        }).
        catch((error) => {
            req.flash("error", `${req.app.locals.i18n.common.flash.errorEditingER}: ${error.message}`);
            next(error);
        });
};

// GET /escapeRooms/:escapeRoomId/evaluation
exports.evaluation = (req, res) => {
    const {escapeRoom} = req;

    res.render("escapeRooms/steps/evaluation", {escapeRoom, "progress": "evaluation"});
};

// POST /escapeRooms/:escapeRoomId/evaluation
exports.evaluationUpdate = async (req, res, next) => {
    const {escapeRoom, body} = req;
    const isPrevious = Boolean(body.previous);
    const progressBar = body.progress;

    escapeRoom.survey = body.survey;
    escapeRoom.pretest = body.pretest;
    escapeRoom.posttest = body.posttest;
    escapeRoom.scoreParticipation = body.scoreParticipation;
    escapeRoom.hintSuccess = body.hintSuccess;
    escapeRoom.hintFailed = body.hintFailed;
    escapeRoom.automaticAttendance = body.automaticAttendance;
    try {
        await escapeRoom.save({"fields": ["survey", "pretest", "posttest", "scoreParticipation", "hintSuccess", "hintFailed", "automaticAttendance"]});
        if (!body.scores || body.scores.length !== escapeRoom.puzzles.length) {
            throw new Error("");
        }
        const promises = [];

        for (const p in body.scores) {
            if (parseFloat(escapeRoom.puzzles[p].score || 0) !== parseFloat(body.scores[p] || 0)) {
                escapeRoom.puzzles[p].score = body.scores[p];
                promises.push(escapeRoom.puzzles[p].save({"fields": ["score"]}));
            }
        }
        await Promise.all(promises);
        res.redirect(`/escapeRooms/${escapeRoom.id}/${isPrevious ? prevStep("evaluation") : progressBar || nextStep("evaluation")}`);
    } catch (error) {
        if (error instanceof Sequelize.ValidationError) {
            error.errors.forEach(({message}) => req.flash("error", message));
            res.redirect(`/escapeRooms/${escapeRoom.id}/evaluation`);
        } else {
            req.flash("error", `${req.app.locals.i18n.common.flash.errorEditingER}: ${error.message}`);
            next(error);
        }
    }
};

// GET /escapeRooms/:escapeRoomId/team
exports.teamInterface = (req, res) => {
    const {escapeRoom} = req;

    res.render("escapeRooms/steps/instructions", {escapeRoom, "progress": "team", "endPoint": "team"});
};

// GET /escapeRooms/:escapeRoomId/class
exports.classInterface = (req, res) => {
    const {escapeRoom} = req;

    res.render("escapeRooms/steps/instructions", {escapeRoom, "progress": "class", "endPoint": "class"});
};
// GET /escapeRooms/:escapeRoomId/indications
exports.indicationsInterface = (req, res) => {
    const {escapeRoom} = req;

    res.render("escapeRooms/steps/instructions", {escapeRoom, "progress": "indications", "endPoint": "indications"});
};

// POST /escapeRooms/:escapeRoomId/class
exports.indicationsInterfaceUpdate = (req, res, next) => saveInterface("indications", req, res, next);


// POST /escapeRooms/:escapeRoomId/team
exports.teamInterfaceUpdate = (req, res, next) => saveInterface("team", req, res, next);

// POST /escapeRooms/:escapeRoomId/class
exports.classInterfaceUpdate = (req, res, next) => saveInterface("class", req, res, next);

// DELETE /escapeRooms/:escapeRoomId
exports.destroy = async (req, res, next) => {
    const transaction = await sequelize.transaction();

    try {
        await req.escapeRoom.destroy({}, {transaction});
        if (req.escapeRoom.attachment) { // Delete the attachment at Cloudinary (result is ignored)
            await attHelper.checksCloudinaryEnv();
            await attHelper.deleteResource(req.escapeRoom.attachment.public_id, models.attachment);
        }
        await transaction.commit();
        req.flash("success", req.app.locals.i18n.common.flash.successDeletingER);
        res.redirect("/escapeRooms");
    } catch (error) {
        await transaction.rollback();
        req.flash("error", `${req.app.locals.i18n.common.flash.errorDeletingER}: ${error.message}`);
        next(error);
    }
};

// GET /escapeRooms/:escapeRoomId/join
exports.studentToken = (req, res, next) => {
    const {escapeRoom} = req;

    if (req.session.user.isStudent) {
        res.render("escapeRooms/indexInvitation", {escapeRoom, "token": req.query.token});
    } else {
        res.status(403);
        next(new Error(403));
    }
};

exports.clone = async (req, res, next) => {
    try {
        const {"title": oldTitle, subject, duration, description, nmax, teamSize, teamAppearance, classAppearance, survey, pretest, posttest, numQuestions, numRight, feedback, forbiddenLateSubmissions, classInstructions, teamInstructions, scoreParticipation, hintLimit, hintSuccess, hintFailed, puzzles, hintApp, assets, attachment} = req.escapeRoom;
        const authorId = req.session.user && req.session.user.id || 0;
        const newTitle = `Copy of ${oldTitle}`;
        const include = [{"model": models.puzzle, "include": [models.hint]}];

        if (hintApp) {
            include.push(models.hintApp);
        }
        if (assets && assets.length) {
            include.push(models.asset);
        }
        if (attachment) {
            include.push(models.attachment);
        }
        const escapeRoom = models.escapeRoom.build({
            "title": newTitle,
            subject,
            duration,
            description,
            nmax,
            teamSize,
            teamAppearance,
            classAppearance,
            survey,
            pretest,
            posttest,
            numQuestions,
            numRight,
            feedback,
            forbiddenLateSubmissions,
            classInstructions,
            teamInstructions,
            scoreParticipation,
            hintLimit,
            hintSuccess,
            hintFailed,
            authorId,
            "puzzles": [...puzzles].map(({title, sol, desc, order, correct, fail, automatic, score, hints}) => ({
                title,
                sol,
                desc,
                order,
                correct,
                fail,
                automatic,
                score,
                "hints": [...hints].map(({content, "order": hintOrder}) => ({content, "order": hintOrder}))
            })),
            "hintApp": hintApp ? attHelper.getFields(hintApp) : undefined,
            "assets": assets && assets.length ? [...assets].map((asset) => attHelper.getFields(asset)) : undefined,
            "attachment": attachment ? attHelper.getFields(attachment) : undefined
        }, {include});
        const saved = await escapeRoom.save();

        res.redirect(`/escapeRooms/${saved.id}/edit`);
    } catch (err) {
        next(err);
    }
};
