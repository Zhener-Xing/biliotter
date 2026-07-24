const { Skill } = require('./Skill');
const { GameQuizSkill, gameQuizSkill } = require('./game-quiz-skill');
const {
  LearningPlanSkill,
  learningPlanSkill,
  tryHandlePlanChat,
} = require('./learning-plan');

const chatSkills = [gameQuizSkill, learningPlanSkill];

module.exports = {
  Skill,
  GameQuizSkill,
  gameQuizSkill,
  LearningPlanSkill,
  learningPlanSkill,
  tryHandlePlanChat,
  chatSkills,
};
