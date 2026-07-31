---
title: react hooks 基础
date: 2019-10-31 11:10:32
tags: [react, hooks]
categories: react
---

## React Hooks

### 1. useState

- 参数类型：object、number、string、bool等等类型或者函数（只有在初始化的时候执行一次）
- 返回值 [xx, setXx] （第一个值是存储的值，第二个值是改变值的方法（注意传入新的内存地址））

<!-- more -->

```
function Counter({initialCount}) {
  const [count, setCount] = useState(initialCount);
  return (
    <>
      Count: {count}
      <button onClick={() => setCount(initialCount)}>Reset</button>
      <button onClick={() => setCount(prevCount => prevCount - 1)}>-</button>
      <button onClick={() => setCount(prevCount => prevCount + 1)}>+</button>
    </>
  );
}
```

> 注意上述例子中setCount可以传入函数，函数的参数是最新的存储值，函数的返回值是要设置的值

### 2、useEffect（didMount、didUpdate）

- 参数
  * 第一个参数是函数didUpdate，必填， 函数体中的代码会在render之后执行，此函数的返回函数会在组件卸载之前执行（相当于原来的componentWillUnmount中）
  * 第二个参数可填可不填，相当于在didMount、didUpdate执行

1、如果不填相当于每次都执行
2、填[] didMount执行，didUpdate不执行
3、如果传[xxx]，didMount执行一次，当xxx发生变化的时候didUpdate会再执行

```
useEffect(
  () => {
    const subscription = props.source.subscribe();
    return () => {
      subscription.unsubscribe();
    };
  },
  [props.source],
);
```

### 3、useContext

- 参数 接收一个 context 对象（React.createContext 的返回值）并返回该 context 的当前值

> 注意当前的 context 值由上层组件中距离当前组件最近的 `<MyContext.Provider>` 的 value prop 决定

```
const DataState = React.createContext({});
 <DataState.Provider
        value={{
          recommendState,
          dispatch,
          doRecommendRef
        }}>
        <XXX />
  </DataState.Provider>
```

（xxx组件中）

```
 const { recommendState, dispatch } = useContext(DataState)
```

### 4、useReducer

```
const [state, dispatch] = useReducer(reducer, initialArg, init);
```

使用方法和Redux类似

* 例子

```
const initialState = {count: 0};

function reducer(state, action) {
  switch (action.type) {
    case 'increment':
      return {count: state.count + 1};
    case 'decrement':
      return {count: state.count - 1};
    default:
      throw new Error();
  }
}

function Counter() {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <>
      Count: {state.count}
      <button onClick={() => dispatch({type: 'increment'})}>+</button>
      <button onClick={() => dispatch({type: 'decrement'})}>-</button>
    </>
  );
}
```

> 在某些场景下，useReducer 会比 useState 更适用，例如 state 逻辑较复杂且包含多个子值，或者下一个 state 依赖于之前的 state 等。并且，使用 useReducer 还能给那些会触发深更新的组件做性能优化，因为你可以向子组件传递 dispatch 而不是回调函数。

### 5、useCallback

- 参数 第一个是函数，第二个参数可以不传或者传数组（依赖项）

```
const memoizedCallback = useCallback(
  () => {
    doSomething(a, b);
  },
  [a, b],
);
```

> 当依赖项发生变化的时候，memoizedCallback会得到新的函数，useCallback(fn, deps) 相当于 useMemo(() => fn, deps)

### 6、useMemo

```
const memoizedValue = useMemo(() => computeExpensiveValue(a, b), [a, b]);
```

> 传入 useMemo 的函数会在渲染期间执行。请不要在这个函数内部执行与渲染无关的操作，诸如副作用这类的操作属于 useEffect 的适用范畴，而不是 useMemo。
> 如果没有提供依赖项数组，useMemo 在每次渲染时都会计算新的值

### 7、useRef

useRef 返回一个可变的 ref 对象，其 .current 属性被初始化为传入的参数（initialValue）。返回的 ref 对象在组件的整个生命周期内保持不变。

```
function TextInputWithFocusButton() {
  const inputEl = useRef(null);
  const onButtonClick = () => {
    // `current` 指向已挂载到 DOM 上的文本输入元素
    inputEl.current.focus();
  };
  return (
    <>
      <input ref={inputEl} type="text" />
      <button onClick={onButtonClick}>Focus the input</button>
    </>
  );
}
```

> 注意：ref.current上可以保存一些值，相当于this的功能

* 实例

```
function Timer() {
  const intervalRef = useRef();

  useEffect(() => {
    const id = setInterval(() => {
      // ...
    });
    intervalRef.current = id;
    return () => {
      clearInterval(intervalRef.current);
    };
  });

  // ...
}
```

### 8、useImperativeHandle

useImperativeHandle 可以让你在使用 ref 时自定义暴露给父组件的实例值。
