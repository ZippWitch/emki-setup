const express = require('express');
const app = express();
const Database = require('better-sqlite3');
const db = new Database('main.db');
const session = require('express-session');
const path = require('node:path');
const { z } = require('zod');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        email TEXT NOT NULL,
        number TEXT NOT NULL,
        fullname TEXT NOT NULL,
        role INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        paymentMethod INTEGER NOT NULL,
        status INTEGER NOT NULL DEFAULT 0,
        userId INTEGER NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requestId INTEGER NOT NULL UNIQUE,
        userId INTEGER NOT NULL,
        text TEXT NOT NULL,
        FOREIGN KEY(requestId) REFERENCES requests(id),
        FOREIGN KEY(userId) REFERENCES users(id)
    );
`);

db.prepare('INSERT INTO users (login, password, email, number, fullname, role) VALUES (?,?,?,?,?,?) ON CONFLICT(login) DO NOTHING;')
    .run('Admin', 'KorokNET', 'admin@korok.net', '8(888)888-88-88', 'Администратор', 0);

class WebError extends Error {
    constructor(data = {}) {
        super(data.devMessage || 'no dev data');
        this.userMessage = data.userMessage || 'Непредвиденная ошибка';
    }
}

app.set('view engine', 'pug');
app.set('views', 'views');

app.use(session({
    secret: 'keyboard cat',
    resave: false,
    saveUninitialized: true
}));

app.use(express.static(path.join(__dirname, 'static')));

app.get('/', (req, res, next) => {
    if (req.session.user) next();
    else next('route');
}, function (req, res) {
    const pageNum = Math.max(1, parseInt(req.query.p) || 1);
    const limit = 3;
    const offset = (pageNum - 1) * limit;

    switch (req.session.user.role) {
        case 0: {
            const filterStatus = req.query.status !== undefined && req.query.status !== '' ? Number(req.query.status) : null;

            let countQuery = 'SELECT COUNT(*) as count FROM requests';
            let dataQuery = 'SELECT requests.*, users.fullname FROM requests JOIN users ON requests.userId = users.id';
            const params = [];

            if (filterStatus !== null) {
                countQuery += ' WHERE status = ?';
                dataQuery += ' WHERE requests.status = ?';
                params.push(filterStatus);
            }

            dataQuery += ' ORDER BY requests.status ASC LIMIT ? OFFSET ?';
            const totalCount = db.prepare(countQuery).get(...params).count;
            const totalPages = Math.ceil(totalCount / limit) || 1;

            const requestsAdmin = db.prepare(dataQuery).all(...params, limit, offset);

            res.render('index', {
                page: 'admin',
                user: req.session.user,
                requests: requestsAdmin,
                filterStatus: req.query.status || '',
                currentPage: pageNum,
                totalPages: totalPages
            });
            break;
        }
        default: {
            const totalCount = db.prepare('SELECT COUNT(*) as count FROM requests WHERE userId = ?').get(req.session.user.id).count;
            const totalPages = Math.ceil(totalCount / limit) || 1;

            const requestsUser = db.prepare(`
                SELECT requests.*, reviews.text as reviewText 
                FROM requests 
                LEFT JOIN reviews ON requests.id = reviews.requestId 
                WHERE requests.userId = ? 
                ORDER BY requests.id DESC 
                LIMIT ? OFFSET ?
            `).all(req.session.user.id, limit, offset);

            res.render('index', {
                page: 'authenticated',
                user: req.session.user,
                requests: requestsUser,
                currentPage: pageNum,
                totalPages: totalPages
            });
            break;
        }
    }
});

app.get('/', function (req, res) {
    res.render('index', { page: 'login' });
});

app.post('/request', express.urlencoded({ extended: false }), function (req, res) {
    try {
        const schema = z.object({
            coursename: z.enum([
                'Основы алгоритмизации и программирования',
                'Основы веб-дизайна',
                'Основы проектирования баз данных'
            ], { errorMap: () => ({ message: 'Выберите курс из списка' }) }),
            date: z.coerce.date('Неправильный формат даты'),
            paymentMethod: z.string().transform(Number)
        });

        const parsed = schema.parse(req.body);

        db.prepare('INSERT INTO requests (name, date, paymentMethod, userId) VALUES (?,?,?,?)')
            .run(parsed.coursename, parsed.date.toString(), parsed.paymentMethod, req.session.user.id);

        res.redirect('/');
    } catch (error) {
        const msg = error instanceof z.ZodError ? error.issues[0].message : 'Ошибка создания заявки';
        console.log(req.session.user)
        console.log(error)
        const requestsUser = db.prepare('SELECT requests.*, reviews.text as reviewText FROM requests LEFT JOIN reviews ON requests.id = reviews.requestId WHERE requests.userId = ? ORDER BY requests.id DESC LIMIT 3').all(req.session.user.id);
        res.render('index', { page: 'authenticated', user: req.session.user, requests: requestsUser, error: msg, currentPage: 1, totalPages: 1 });
    }
});

app.post('/request-edit', express.urlencoded({ extended: false }), function (req, res) {
    try {
        if (req.session.user.role !== 0) throw new WebError({ userMessage: 'Операция для администратора' });

        const newStatus = Number(req.body.status);
        const id = Number(req.body.id);

        db.prepare('UPDATE requests SET status=? WHERE id=?').run(newStatus, id);
        res.redirect('/');
    } catch (error) {
        res.redirect('/');
    }
});

app.post('/review', express.urlencoded({ extended: false }), function (req, res) {
    try {
        const schema = z.object({
            requestId: z.string().transform(Number),
            text: z.string().min(1, 'Отзыв не может быть пустым')
        });

        const parsed = schema.parse(req.body);
        const reqCard = db.prepare('SELECT status FROM requests WHERE id = ? AND userId = ?').get(parsed.requestId, req.session.user.id);

        if (!reqCard || reqCard.status !== 2) {
            throw new WebError({ userMessage: 'Отзыв доступен только после прохождения курса' });
        }

        db.prepare('INSERT INTO reviews (requestId, userId, text) VALUES (?, ?, ?)')
            .run(parsed.requestId, req.session.user.id, parsed.text);

        res.redirect('/');
    } catch (error) {
        const msg = error instanceof z.ZodError ? error.issues[0].message : (error.userMessage || 'Ошибка добавления отзыва');
        const requestsUser = db.prepare('SELECT requests.*, reviews.text as reviewText FROM requests LEFT JOIN reviews ON requests.id = reviews.requestId WHERE requests.userId = ? ORDER BY requests.id DESC LIMIT 3').all(req.session.user.id);
        res.render('index', { page: 'authenticated', user: req.session.user, requests: requestsUser, error: msg, currentPage: 1, totalPages: 1 });
    }
});

app.get('/login', function (req, res) {
    res.render('index', { page: 'login' });
});

app.get('/register', function (req, res) {
    res.render('index', { page: 'register' });
});

app.post('/register', express.urlencoded({ extended: false }), function (req, res) {
    try {
        const schema = z.object({
            login: z.string().min(6, 'Логин должен быть не менее 6 символов').regex(/^[a-zA-Z0-9]+$/, 'Логин должен состоять из латиницы и цифр'),
            password: z.string().min(8, 'Пароль должен быть не менее 8 символов'),
            fullname: z.string().regex(/^[а-яА-ЯёЁ\s]+$/, 'ФИО должно содержать только кириллицу и пробелы'),
            number: z.string().refine((val) => {
                const parsed = parsePhoneNumberFromString(val, 'RU');
                return parsed && parsed.isValid() && val.startsWith('8(');
            }, 'Формат телефона должен быть: 8(XXX)XXX-XX-XX'),
            email: z.string().email('Некорректный формат электронной почты')
        });

        const parsed = schema.parse(req.body);

        db.prepare('INSERT INTO users (login, password, email, number, fullname) VALUES (?,?,?,?,?)')
            .run(parsed.login, parsed.password, parsed.email, parsed.number, parsed.fullname);

        res.redirect('/login');
    } catch (error) {
        let errMessage = 'Неизвестная ошибка';
        if (error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            errMessage = 'Пользователь с указанным логином уже существует';
        } else if (error instanceof z.ZodError) {
            errMessage = error.issues[0].message;
        }
        res.render('index', { page: 'register', error: errMessage });
    }
});

app.post('/login', express.urlencoded({ extended: false }), function (req, res) {
    try {
        const schema = z.object({
            login: z.string().min(1, 'Введите логин'),
            password: z.string().min(1, 'Введите пароль')
        });

        const parsed = schema.parse(req.body);

        const user = db.prepare('SELECT * from users WHERE login=? AND password=?').get(parsed.login, parsed.password);
        if (!user) throw new WebError({ userMessage: 'Неправильный пароль или логин' });

        req.session.regenerate(function (err) {
            if (err) throw err;

            req.session.user = {
                login: user.login,
                role: user.role,
                id: user.id
            };

            console.log(req.session.user)

            req.session.save(function (err) { if (err) throw err; res.redirect('/'); });
        });
    } catch (error) { res.render('index', { page: 'login', error: error instanceof WebError ? error.userMessage : (error instanceof z.ZodError ? error.issues[0].message : 'Неизвестная ошибка') }); }
});

app.get('/logout', function (req, res) {
    req.session.user = null;
    req.session.save(function () {
        req.session.regenerate(function () {
            res.redirect('/');
        });
    });
});

app.listen(3000, () => { console.log('Server is running on http://localhost:3000'); });