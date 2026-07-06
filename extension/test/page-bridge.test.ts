import assert from "node:assert/strict";
import test from "node:test";
import { readFestivalVideoDetailFromSources } from "../src/content/page-bridge-detail";

test("page bridge preserves active episode id when falling back to player input", () => {
  const detail = readFestivalVideoDetailFromSources({
    initialState: {
      episodes: [
        {
          id: 1,
          bvid: "BVold",
          cid: 11,
          title: "上一话",
        },
      ],
    },
    playerInput: {
      bvid: "BVcurrent",
      cid: 987654,
    },
    activeEpId: "508404",
    activeCid: "987654",
    activeTitle: "第46话",
  });

  assert.deepEqual(detail, {
    epId: "508404",
    bvid: "BVcurrent",
    cid: 987654,
    title: "第46话",
  });
});

test("page bridge preserves active cid when matched candidate lacks cid", () => {
  const detail = readFestivalVideoDetailFromSources({
    initialState: {
      videoInfo: {
        bvid: "BVcurrent",
        title: "第46话",
      },
    },
    activeCid: "987654",
    activeTitle: "第46话",
  });

  assert.deepEqual(detail, {
    epId: undefined,
    bvid: "BVcurrent",
    cid: "987654",
    title: "第46话",
  });
});

test("page bridge uses playinfo fallback when active DOM has not exposed episode identity", () => {
  // Reproduces the situation from the cross-bangumi navigation bug:
  // - `__INITIAL_STATE__.epInfo` and `epList` still hold the previous bangumi's
  //   data (ep_id 1231523 with title "秘密。（Sub rosa.）") because Bilibili's
  //   SPA has not yet refreshed those globals.
  // - `__playinfo__` is already populated with the freshly loaded episode
  //   (ep_id 1231525 with the new title "羽丘的不可思议女孩").
  // The page bridge must resolve to the fresh ep_id so that downstream
  // broadcasts and shares carry the correct shared video URL.
  const detail = readFestivalVideoDetailFromSources({
    initialState: {
      epInfo: {
        ep_id: 1231523,
        bvid: "BVoldsubrosa",
        cid: 1100000001,
        title: "第1话 秘密。（Sub rosa.）",
      },
      epList: [
        {
          id: 1231523,
          ep_id: 1231523,
          bvid: "BVoldsubrosa",
          cid: 1100000001,
          title: "第1话 秘密。（Sub rosa.）",
        },
      ],
    },
    playInfo: {
      result: {
        arc: {
          bvid: "BVnewseason",
          cid: 1200000099,
        },
        supplement: {
          ogv_episode_info: {
            episode_id: 1231525,
            index_title: "1",
            long_title: "羽丘的不可思议女孩",
          },
          play_view_business_info: {
            episode_info: {
              ep_id: 1231525,
              cid: 1200000099,
            },
          },
        },
      },
    },
    activeTitle: "第1话 羽丘的不可思议女孩",
  });

  assert.deepEqual(detail, {
    epId: 1231525,
    bvid: "BVnewseason",
    cid: 1200000099,
    title: "第1话 羽丘的不可思议女孩",
  });
});

test("page bridge prefers active DOM episode over stale playinfo during cross-bangumi SPA navigation", () => {
  const detail = readFestivalVideoDetailFromSources({
    playInfo: {
      result: {
        arc: {
          bvid: "BVoldsubrosa",
          cid: 27730904912,
        },
        supplement: {
          ogv_episode_info: {
            episode_id: 1231523,
            index_title: "1",
            long_title: "秘密。（Sub rosa.）",
          },
          play_view_business_info: {
            episode_info: {
              ep_id: 1231523,
              cid: 27730904912,
            },
          },
        },
      },
    },
    playerInput: {
      cid: undefined,
    },
    activeEpId: "1183102",
    activeCid: "27730052544",
    activeTitle: "第1话 羽丘的不可思议女孩",
  });

  assert.deepEqual(detail, {
    epId: "1183102",
    bvid: undefined,
    cid: "27730052544",
    title: "第1话 羽丘的不可思议女孩",
  });
});

test("page bridge resolves current bangumi episode from playinfo when season page has no initial state", () => {
  const detail = readFestivalVideoDetailFromSources({
    playInfo: {
      result: {
        arc: {
          bvid: "BV17W411y74a",
          cid: 55445162,
        },
        supplement: {
          ogv_episode_info: {
            episode_id: 508404,
            index_title: "46",
            long_title: "汤姆与小老鼠 Tom and Cherie",
          },
          play_view_business_info: {
            episode_info: {
              ep_id: 508404,
              cid: 55445162,
            },
          },
        },
      },
    },
    playerInput: {
      cid: undefined,
    },
    activeTitle: "第46话 汤姆与小老鼠 Tom and Cherie",
  });

  assert.deepEqual(detail, {
    epId: 508404,
    bvid: "BV17W411y74a",
    cid: 55445162,
    title: "第46话 汤姆与小老鼠 Tom and Cherie",
  });
});
