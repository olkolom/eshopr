const dotenv =  require('dotenv')
const { google } = require('googleapis')
const express = require('express')
const session = require('express-session')
const MongoDBStore = require('connect-mongodb-session')(session)
const ejs = require('ejs')
const json2csv = require('json2csv')
const fs = require('fs')
const { MongoClient } = require('mongodb')

dotenv.config()
const config = {
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUrl: process.env.GOOGLE_REDIRECT_URL,
  sessionSecret: process.env.SESSION_SECRET,
  port: process.env.PORT,
  mongoUri: process.env.MONGO_URI,
  eshopUri: process.env.ESHOP_URI,
}

const app = express()

const dBclient = new MongoClient(config.mongoUri, { useUnifiedTopology: true })
dBclient.connect().then(() => console.log('Connected to DB'))

const sessionStore = new MongoDBStore({
  uri: config.mongoUri,
  collection: 'sessions'
})

const auth = new google.auth.OAuth2(
  config.googleClientId,
  config.googleClientSecret,
  config.googleRedirectUrl
)

app.set('views', './views')
app.set('view engine', 'ejs')

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  store: sessionStore,
  cookie: { secure: true },
  cookie: { maxAge: 7200000 }
}))

app.get('/callback', (req, res) => {
  const code = req.query.code
  if (code) { 
    auth.getToken(code)
    .then(data => {
      console.log('Successfully authenticated')
      auth.setCredentials(data.tokens)
      req.session.isAuthed = true
      res.redirect('/')
    })} else res.send('Something wrong')
})

app.get('/', (req, res) => {
  if (!req.session.isAuthed) {
    const connectionUrl = auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/userinfo.email'
    })
    console.log('Login attempt...')
    res.redirect(connectionUrl)
  } else { 
      const oauth2 = google.oauth2({ version: 'v2', auth })
      oauth2.userinfo.get()
      .then(userinfo => {
        if (!req.session.user) req.session.user = userinfo.data.email
        console.log(`User: ${userinfo.data.email}`)
        //mainView(req,res)
        res.send("Auht OK")
      })
  }  
})

app.use((req, res, next) => req.session.isAuthed ? next() : res.redirect('/'))

app.get("/protected", (req, res)=> {res.send("Protected")})

app.listen(config.port, () => {
  console.log(`App listening at http://localhost:${config.port}`)
})
