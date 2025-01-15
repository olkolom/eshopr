const dotenv =  require('dotenv')
const { google } = require('googleapis')
const express = require('express')
const session = require('express-session')
const MongoDBStore = require('connect-mongodb-session')(session)
const ejs = require('ejs')
const json2csv = require('json2csv')
const fs = require('fs')
const dbModule = require ('./getorders.js')
const users = require('./users.json')

dotenv.config()
const config = {
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUrl: process.env.GOOGLE_REDIRECT_URL,
  sessionSecret: process.env.SESSION_SECRET,
  port: process.env.PORT,
  mongoUri: process.env.MONGO_URI,
  eshopUri: process.env.ESHOP_URI,
  url: process.env.URL,
}

const app = express()

const dataSource = dbModule.init(config.mongoUri)

const sessionStore = new MongoDBStore({
  uri: config.mongoUri,
  collection: 'sessions',
})

app.set('views', './views')
app.set('view engine', 'ejs')

app.use('/public', express.static('public'))

const cookieSet = { maxAge: 43200000 }
if (config.url !== undefined) {
  app.set('trust proxy', 1)
  cookieSet.secure = true
}

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  store: sessionStore,
  cookie: cookieSet,
}))

const auth = new google.auth.OAuth2(
  config.googleClientId,
  config.googleClientSecret,
  config.googleRedirectUrl
)

app.get('/auth', (req, res) => {
  const code = req.query.code
  if (code) { 
    return auth.getToken(code)
    .then(data => {
      auth.setCredentials(data.tokens)
      const oauth2 = google.oauth2({ version: 'v2', auth })
      oauth2.userinfo.get()
      .then(userinfo => {
        let date = new Date()
        let loginTime = date.toISOString()
        if (users.allowedUsers.includes(userinfo.data.email)) {
          req.session.isAuthed = true
          req.session.user = userinfo.data.email
          req.session.loginTime = loginTime
          console.log(`${userinfo.data.email} have logged in at ${loginTime}`)
          res.redirect('/')
        } else {
          console.log(`${userinfo.data.email} have tried to log in at ${loginTime}`)
          res.send('Nepovolený přístup')
        }
      })
    })
    .catch(() => res.send('Something went wrong'))
  }
  const connectionUrl = auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/userinfo.email'
    })
  console.log('Login attempt...')
  res.redirect(connectionUrl)
})

app.use((req, res, next) => req.session.isAuthed ? next() : res.redirect('/auth'))

var dataProcessing = false
app.get('/refresh', async (req, res, next)=> {
  console.log(req.session.user, 'Processing data...')
  if (dataProcessing === true) {return next()}
  dataProcessing = true
  req.session.data = await dataSource.getOrdersData(config.eshopUri)
  req.session.data.stores = users[req.session.user];
  dataProcessing = false;
  res.redirect('/')
})
app.get('/refresh', async (req, res)=> {res.send('Double click')})

app.use((req, res, next) => (req.session.data !== undefined) ? next() : res.redirect('/refresh'))

app.get("/", (req, res)=> {
  res.render('index', {...req.session.data, user: req.session.user } )
})

app.get("/products", (req, res)=> {
  if (req.query.action === undefined && req.query.item === undefined)
    { 
      if (req.query.sort === "1") {
        req.session.data.sort = !req.session.data.sort;
        const { productList } = req.session.data;
        const prodListShort = [];
        const newProdList = [];
        if (req.session.data.sort) {
          productList.forEach((item, index) => prodListShort.push(item.productId + item.size + "#" + index));
          prodListShort.sort();
          prodListShort.forEach(i => newProdList.push(productList[i.split("#")[1]]));
        } else {
          productList.forEach((item, index) => prodListShort.push(item.orderId + "#" + index));
          prodListShort.sort();
          prodListShort.forEach(i => newProdList.unshift(productList[i.split("#")[1]]));
        };
        req.session.data.productList = newProdList;
      }
      return res.render('products', req.session.data) 
    }
  if (req.query.action !== undefined) {
    let action = req.query.action.split('_')
    let type = action[0]
    let itemIndex = parseInt(action[1],10)
    let index = req.session.data.productList.findIndex(item => item.index === itemIndex)
    req.session.data.productList[index].action = type
    return res.render('products', req.session.data )
  }
  dataSource.getItem(req.query.item).then( item => {
    if (item !== null) {
      let reversedIndex = req.session.data.productList.slice().reverse().findIndex(product => (
        product.productId === item.model 
        && product.size == item.size 
        && product.action === 'n'
        && product.sale
        && product.storeID === users[req.session.user][0]
      ))
      if (reversedIndex !== -1) {
        const index = req.session.data.productList.length -1 -reversedIndex
        req.session.data.productList[index].action = 'p'
      }
    }
    res.render('products', req.session.data)
  })  
})

app.get("/order", (req, res)=> {
  if (req.query.orderid === undefined) { return res.redirect('/') }
  dataSource.getOrder(req.query.orderid).then(orderData => res.render('order', orderData))
})

app.get("/sell", (req, res)=> {
  if (req.query.id === undefined) { return res.redirect('/') };
  const storeID = req.query.id;
  const user = req.session.user;
  const items = req.session.data.productList.filter( item => item.action == 'p' && item.storeID == storeID );
  if (items.length !== 0) { 
    dataSource
    .saveSale(items, storeID, user)
    .then(saleSaved => saleSaved ? res.redirect(`/sales?id=${storeID}`) : res.redirect('/products'));
  } else res.redirect('/products');
});

app.get("/sales", (req, res)=> {
  if (req.query.id === undefined) { return res.redirect('/') };
  const date = req.query.date ? req.query.date : new Date().toISOString().slice(0,10);
  dataSource.getSales(req.query.id, date).then(salesData => res.render('sales', salesData));
})

app.get("/ean", (req, res)=> {
  if (req.query.id === undefined) { return res.redirect('/') };
  dataSource.getEan(req.query.id).then(salesData => res.render('ean', salesData))
})

app.get("/return", (req, res)=> {
  if (req.query.item !== undefined ) {
    dataSource.getOrdersByItem(req.query.item).then( orders => res.render('ret_input',orders))
  } else { 
    req.query.orderid && !isNaN(parseInt(req.query.orderid)) ?
      dataSource.getOrder(req.query.orderid).then(orderData => res.render('ret_form', orderData)) :
      res.render('ret_input', { orders : [] });
  }
})

app.get("/retsave", (req, res)=> {
  if (req.query.order === undefined ) {return res.redirect('/return')}
  if (req.query.item === undefined ) {return res.send('Žadné zboží')}
  if (req.query.acc === "" && req.query.comment === "") {return res.send('Není číslo účtu')}
  dataSource.getOrder(req.query.order)
  .then(orderData => {
    let items = []
    if (!Array.isArray(req.query.item)) items.push(orderData.items[req.query.item])
    else req.query.item.forEach(item => items.push(orderData.items[parseInt(item, 10)]))
    return {
      order: req.query.order,
      account: req.query.acc,
      bank: req.query.bank,
      delivery: req.query.delivery,
      payment: req.query.payment,
      items: items,
      comment: req.query.comment,
    }
  })
  .then(data => dataSource.saveReturn(data))
  .then(data => res.redirect("/returns"))
})

app.get("/returns", (req, res)=> {
  const isAdmin = req.session.user === "alexej@solomio.cz" ? true : false;
  if (req.query.orderid !== undefined ) {}
  else dataSource.getReturns().then(data => res.render('returns', {...data, isAdmin}))
})

app.get("/ppl", (req, res, next)=> {
  const csvParser = new json2csv.Parser({
    fields: ['vs','jmeno','telefon','email','ulice','mesto','psc','zeme','dobirka','poznamka', 'services'],
    delimiter: ';',
  })
  if (req.query.ord !== undefined ) {
    let orderNumbers
    Array.isArray(req.query.ord) ? orderNumbers=req.query.ord : orderNumbers=[req.query.ord]
    const ordersPPL = []
    orderNumbers.forEach(orderNumber => {
      let order = req.session.data.ordersList.find(item => item.id == orderNumber)
      ordersPPL.push(order.pplData)
    })
    const csv = csvParser.parse(ordersPPL)
    const file = __dirname + '/public/ppl.csv'
    fs.writeFile(file, csv, err => {
        if (err) next(err)
        res.download(file)
    })
  } else res.redirect("/")
})

app.get("/abo", (req, res, next)=> {
  if (req.session.user !== "alexej@solomio.cz") return res.redirect("/");
  const command = req.query.save === "true" ? "savePays" : "getPays";
  dataSource.getReturns(command).then(data => res.render('returns', {...data, isAdmin: true}))
});

app.listen(config.port, () => {
  console.log(`App running at http://localhost:${config.port}`)
})