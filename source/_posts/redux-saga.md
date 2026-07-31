---
title: redux-saga
date: 2018-03-19 10:58:18
tags: [react, redux, redux-saga]
categories: react
---

## redux-saga

redux-saga 是一个旨在于在React/Redux应用中更好、更易地解决异步操作（action）的库。主要模块是 saga 会像一个分散的支线在你的应用中单独负责解决异步的action（类似于后台运行的进程）

<!-- more -->

## API

1、put

创建一条 Effect 描述信息，指示 middleware 发起一个 action 到 Store，类似于dispatch一个action的作用

```
yield put({ type: 'CLICK_BTN' });
```

2、select

作用和 redux thunk 中的 getState 相同

```
const archives = yield select(state => state.archives);
```

3、takeEvery

在发起的 action 与 pattern 匹配时派生指定的 saga，注意每响应一个action，将会在后台启动一个新的saga任务

```
export function* archivesFetchResumeList_saga(){
  yield* takeEvery(ARCHIVES_FETCH_FOLLOW_DATA, updateTask);
}
```

4、takeLatest

作用和takeEvery类似，但和takeEvery不同的是，takeLatest自动取消之前启动的所有 saga 任务（如果在执行中），请注意它取消的是和原来一个action对应的saga

```
export function* archivesFetchResumeList_saga(){
  yield* takeLatest(ARCHIVES_FETCH_FOLLOW_DATA, updateTask);
}
```

5、take（请注意这个api）

它的作用是创建一条 Effect 描述信息，指示 middleware 等待 Store 上指定的 action。 Generator 会暂停，直到一个与 pattern 匹配的 action 被发起。

例子1：下面写一个倒数的例子，当接收到 BEGIN_COUNT 的 action，则开始倒数，而接收到 STOP_COUNT 的 action， 则停止倒数。

```
function* count(number) {
  let currNum = number;

  while (currNum >= 0) {
    console.log(currNum--);
    yield delay(1000);
  }
}

function countSaga* () {
  while (true) {
    const { payload: number } = yield take(BEGIN_COUNT);
    const countTaskId = yield fork(count, number);

    yield take(STOP_TASK);
    yield cancel(countTaskId);
  }
}
```

6、阻塞调用和无阻塞调用

redux-saga 可以用 fork 和 call 来调用子 saga ，其中 fork 是无阻塞型调用，call 是阻塞型调用。

## 优缺点

### 优点

1、流程拆分更细，异步的action 以及特殊要求的action（更复杂的action）都在sagas中做统一处理，流程逻辑更清晰，模块更干净；

2、以用同步的方式写异步代码，可以做一些async 函数做不到的事情 (无阻塞并发、取消请求)
能容易地测试 Generator 里所有的业务逻辑

3、 可以通过监听Action 来进行前端的打点日志记录，减少侵入式打点对代码的侵入程度

## 业务结合

1、异步请求与列表没有先后顺序的怎么写通用的saga？

2、一个列表中请求列表数据后，根据简历ids请求操作记录，但是在请求操作记录接口返回前，我们切换了页面，又请求了列表数据，但是数据不对，这个问题原因是什么？怎么解决

3、怎么设置接口超时，怎么设置loading在>=500ms消失？
